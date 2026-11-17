import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-e3k4z5d-shard-00-00.3ov8lfd.mongodb.net:27017,ac-e3k4z5d-shard-00-01.3ov8lfd.mongodb.net:27017,ac-e3k4z5d-shard-00-02.3ov8lfd.mongodb.net:27017/?ssl=true&replicaSet=atlas-hn3gb5-shard-0&authSource=admin`);



export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("hireloopdb");
const users = database.collection("user");
const jobs = database.collection("jobs");
const applications = database.collection("applications");
const payments = database.collection("payments");
// one payment record per Stripe checkout session
payments.createIndex({ sessionId: 1 }, { unique: true });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// free plan includes this many applications in total; paying unlocks unlimited
const FREE_APPLICATION_LIMIT = 3;

app.get('/', (req, res) => {
    res.send('hire loop is looping')
})


app.get('/users', async (req, res) => {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})


// jobs related apis
app.get('/jobs', async (req, res) => {

    const query = {};
    // console.log('query', req.query);
    if (req.query) {
        if (req.query.jobType) {
            // repeated ?jobType=a&jobType=b params arrive as an array — match any of them
            query.jobType = { $in: [].concat(req.query.jobType) };
        }
        if (req.query.isRemote) {
            query.isRemote = req.query.isRemote === 'true';
        }
        if (req.query.category) {
            query.category = { $in: [].concat(req.query.category) };
        }
        // recruiter scoping: only the jobs this account created
        if (req.query.createdBy) {
            query.createdBy = req.query.createdBy;
        }
        if (req.query.search) {
            query.$or = [
                { title: { $regex: req.query.search, $options: 'i' } },
                { companyName: { $regex: req.query.search, $options: 'i' } },
                { responsibilities: { $regex: req.query.search, $options: 'i' } },
                { requirements: { $regex: req.query.search, $options: 'i' } }
            ];
        }
    }

    const cursor = jobs.find(query);
    const result = await cursor.toArray();
    res.send(result);
})

app.get(`/jobs/:id`, async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await jobs.findOne(query);
    res.send(result);
})

app.post('/jobs', async (req, res) => {
    const job = req.body;
    // let the API sort by recency even if the client forgets the timestamp
    if (!job.createdAt) job.createdAt = new Date();
    const result = await jobs.insertOne(job);
    res.send(result);
})


app.delete('/jobs/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await jobs.deleteOne(query);
    res.send(result);
})

// applications related apis

app.get('/applications', async (req, res) => {

    const query = {};

    if (req.query.applicantId) {
        query.userId = req.query.applicantId;
    }

    // recruiter "view applications by job" filter
    if (req.query.jobId) {
        query.jobId = req.query.jobId;
    }

    // recruiter scoping: applications to any job this recruiter created
    // (join — find their jobs, then match applications by those job ids).
    // An explicit ?jobId filter wins, so ?ownerId&jobId still narrows to one job.
    if (req.query.ownerId) {
        const ownJobs = await jobs.find({ createdBy: req.query.ownerId }).toArray();
        const ownJobIds = ownJobs.map(job => String(job._id));
        query.jobId = req.query.jobId
            ? req.query.jobId // already scoped to one of their jobs
            : { $in: ownJobIds };
    }

    const cursor = applications.find(query);
    const result = await cursor.toArray();
    res.send(result);
})

// recruiter updates an application's status (New → Interviewing → Reviewing → Rejected)
const APPLICATION_STATUSES = ['New', 'Interviewing', 'Reviewing', 'Rejected'];

app.patch('/applications/:id', async (req, res) => {
    const { id } = req.params;
    if (!/^[a-f\d]{24}$/i.test(id)) {
        return res.status(400).send({ error: 'invalid_id', message: 'Not a valid application id.' });
    }

    const { status } = req.body || {};
    if (!APPLICATION_STATUSES.includes(status)) {
        return res.status(400).send({
            error: 'invalid_status',
            message: `Status must be one of: ${APPLICATION_STATUSES.join(', ')}.`,
        });
    }

    const result = await applications.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { status, updatedAt: new Date() } },
        { returnDocument: 'after' }
    );
    if (!result) {
        return res.status(404).send({ error: 'not_found', message: 'Application not found.' });
    }
    res.send(result);
})

app.post('/applications', async (req, res) => {
    const application = req.body;

    // free-plan paywall: after FREE_APPLICATION_LIMIT applications the next
    // apply is rejected until a paid checkout is recorded for this user
    const applicantId = application.userId;
    if (applicantId) {
        const hasPaid = await payments.findOne({ userId: applicantId, status: 'paid' });
        if (!hasPaid) {
            const appliedCount = await applications.countDocuments({ userId: applicantId });
            if (appliedCount >= FREE_APPLICATION_LIMIT) {
                return res.status(402).send({
                    error: 'limit_reached',
                    message: `Free plan includes ${FREE_APPLICATION_LIMIT} applications. Upgrade to Pro to keep applying.`,
                });
            }
        }
    }

    // timestamp server-side so listings can sort by recency
    if (!application.appliedAt) application.appliedAt = new Date();
    const result = await applications.insertOne(application);
    // keep the job card's applicant counter in sync (ignore malformed ids)
    if (application.jobId && /^[a-f\d]{24}$/i.test(application.jobId)) {
        try {
            await jobs.updateOne({ _id: new ObjectId(application.jobId) }, { $inc: { applicants: 1 } });
        } catch (err) {
            console.dir(err);
        }
    }
    res.send(result);
})

// payments related apis
//
// POST /payments/record — called by the Next.js success page after Stripe
// redirects back. The client only sends the checkout session id; EVERYTHING
// else (payer, amount, plan, paid state) is re-verified here against Stripe
// with the server's own secret key, so a forged or reused session id can
// never mark an account as paid.
app.post('/payments/record', async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).send({ error: 'sessionId is required' });
    }

    let session;
    try {
        session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (err) {
        // unknown/expired session id → not a real payment
        return res.status(400).send({ error: 'Unknown checkout session' });
    }

    if (session.payment_status !== 'paid') {
        return res.status(400).send({ error: 'Payment not completed' });
    }

    // credit the payer recorded in the session metadata — never the caller —
    // so a paid session id belonging to user A can't be used to unlock user B
    const userId = session.metadata?.userId;
    if (!userId) {
        return res.status(400).send({ error: 'Checkout session has no buyer attached' });
    }

    const payment = {
        sessionId,
        userId,
        plan: session.metadata?.planId || 'pro',
        amount: session.amount_total,
        currency: session.currency,
        status: 'paid',
        paidAt: new Date(),
    };

    try {
        await payments.insertOne(payment);
    } catch (err) {
        // duplicate key → this session was already recorded (browser refresh,
        // double redirect). Return the existing record instead of failing.
        if (err?.code === 11000) {
            const existing = await payments.findOne({ sessionId });
            return res.send({ recorded: true, alreadyRecorded: true, payment: existing });
        }
        console.dir(err);
        return res.status(500).send({ error: 'Could not record payment' });
    }

    // flip the user's plan flag so dashboards can show Pro immediately
    const userFilter = /^[a-f\d]{24}$/i.test(userId) ? { _id: new ObjectId(userId) } : { _id: userId };
    try {
        await users.updateOne(userFilter, { $set: { plan: 'paid', paidAt: payment.paidAt } });
    } catch (err) {
        console.dir(err); // payment is recorded; plan flag is a convenience
    }

    res.send({ recorded: true, payment });
})

// GET /payments/status?userId=... — is this account on the paid plan?
app.get('/payments/status', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).send({ error: 'userId is required' });
    }
    const payment = await payments.findOne({ userId, status: 'paid' }, { sort: { paidAt: -1 } });
    res.send({ paid: !!payment, payment });
})


app.listen(port, () => {
    console.log(`hire loop is running on port ${port}`)
})