import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

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

    const cursor = applications.find(query);
    const result = await cursor.toArray();
    res.send(result);
})

app.post('/applications', async (req, res) => {
    const application = req.body;
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


app.listen(port, () => {
    console.log(`hire loop is running on port ${port}`)
})