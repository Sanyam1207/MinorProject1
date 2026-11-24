import mongoose from "mongoose";
import { MONGO_URI, DB_NAME } from "../config/config.js";

const DBConnect = async () => {
    try {
        const uri = MONGO_URI || "mongodb://127.0.0.1:27017";
        const dbName = DB_NAME || "SIH";
        console.log(`Connecting to MongoDB at: ${uri}`);
        await mongoose.connect(`${uri.replace(/\/+$/, "")}/${dbName}`);
        console.log(`✅ SUCCESSFULLY CONNECTED TO MONGO DB DATABASE: [${dbName}]`);
    } catch (error) {
        console.error("❌ MONGODB CONNECTION ERROR:", error.message);
    }
};

export default DBConnect;