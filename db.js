// MongoDB connection utility
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

const uri = process.env.MONGODB_URI || `mongodb+srv://not-alone-back-user-prod:${process.env.DB_PASSWORD}@cluster0.vtsxpbf.mongodb.net/?appName=Cluster0`;
const dbName = process.env.MONGODB_DB || 'notalone';

let client;
let db;

async function connectDB() {
    if (!client || !db) {
        client = new MongoClient(uri, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            },
            // Longer timeouts for slow or flaky networks (e.g. some WiFi)
            connectTimeoutMS: 20000,
            serverSelectionTimeoutMS: 30000,
        }
        );
        await client.connect();
        db = client.db(dbName);
    }
    return db;
}

module.exports = { connectDB };
