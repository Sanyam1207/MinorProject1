// Seed script: populates the Elective collection with synthetic data.
// Run with: node src/scripts/seed-electives.js

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

const MONGO_URI = (process.env.MONGO_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");
const DB_NAME = process.env.DB_NAME || "SIH";

const ElectiveSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    upvotedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    topics: { type: [String], default: [] },
}, { timestamps: true });

const Elective = mongoose.model("Elective", ElectiveSchema);

const SEED_ELECTIVES = [
    {
        name: "Cloud Computing & DevOps",
        topics: [
            "Cloud Architecture", "AWS", "Azure", "GCP",
            "Docker", "Kubernetes", "CI/CD Pipelines",
            "Microservices", "Serverless Computing",
            "Infrastructure as Code", "Terraform",
            "Cloud Security", "Load Balancing"
        ],
    },
    {
        name: "Full Stack Web Development",
        topics: [
            "HTML5 & CSS3", "JavaScript ES6+", "React.js",
            "Node.js", "Express.js", "MongoDB",
            "REST APIs", "GraphQL", "Authentication & JWT",
            "Responsive Design", "TypeScript",
            "Next.js", "Deployment & Hosting"
        ],
    },
    {
        name: "Artificial Intelligence & Deep Learning",
        topics: [
            "Neural Networks", "Convolutional Neural Networks",
            "Recurrent Neural Networks", "Transformers",
            "Natural Language Processing", "Computer Vision",
            "Generative AI", "GANs", "Transfer Learning",
            "TensorFlow", "PyTorch", "Model Optimization",
            "AI Ethics", "Large Language Models"
        ],
    },
    {
        name: "Cybersecurity & Ethical Hacking",
        topics: [
            "Network Security", "Penetration Testing",
            "Cryptography", "Web Application Security",
            "OWASP Top 10", "Malware Analysis",
            "Incident Response", "Firewall Configuration",
            "Security Auditing", "Digital Forensics",
            "Zero Trust Architecture", "SOC Operations"
        ],
    },
    {
        name: "Data Science & Analytics",
        topics: [
            "Python for Data Science", "Pandas & NumPy",
            "Data Wrangling", "Statistical Analysis",
            "Machine Learning Algorithms", "Feature Engineering",
            "Data Visualization with Matplotlib & Seaborn",
            "SQL & NoSQL Databases", "Big Data with Spark",
            "A/B Testing", "Predictive Modeling",
            "Power BI / Tableau"
        ],
    },
    {
        name: "Mobile App Development",
        topics: [
            "React Native", "Flutter", "Dart",
            "iOS Development with Swift",
            "Android Development with Kotlin",
            "Mobile UI/UX Design", "State Management",
            "Push Notifications", "App Store Deployment",
            "Firebase", "REST API Integration",
            "Offline Storage", "Performance Optimization"
        ],
    },
    {
        name: "Internet of Things (IoT)",
        topics: [
            "IoT Architecture", "Sensors & Actuators",
            "Embedded Systems", "Arduino & Raspberry Pi",
            "MQTT Protocol", "Edge Computing",
            "IoT Security", "Smart Home Automation",
            "Industrial IoT", "Wireless Communication Protocols",
            "IoT Data Analytics", "Cloud IoT Platforms"
        ],
    },
    {
        name: "Software Engineering & Agile Practices",
        topics: [
            "Software Development Life Cycle", "Agile & Scrum",
            "Design Patterns", "SOLID Principles",
            "Version Control with Git", "Code Review Practices",
            "Test-Driven Development", "Unit Testing",
            "System Design", "API Design",
            "Documentation", "Project Management with Jira"
        ],
    },
    {
        name: "Database Systems & Administration",
        topics: [
            "Relational Database Design", "SQL Advanced Queries",
            "PostgreSQL", "MySQL", "MongoDB",
            "Database Indexing & Optimization",
            "Replication & Sharding", "Transactions & ACID",
            "Redis & Caching", "Data Warehousing",
            "ETL Pipelines", "Database Security"
        ],
    },
    {
        name: "Natural Language Processing",
        topics: [
            "Text Preprocessing", "Tokenization",
            "Word Embeddings (Word2Vec, GloVe)",
            "Sentiment Analysis", "Named Entity Recognition",
            "Machine Translation", "Text Classification",
            "BERT & Transformer Models", "Chatbot Development",
            "Speech Recognition", "Text Summarization",
            "Prompt Engineering"
        ],
    },
    {
        name: "Quantum Computing Fundamentals",
        topics: [
            "Quantum Bits (Qubits)", "Quantum Gates",
            "Superposition & Entanglement",
            "Quantum Algorithms (Shor's, Grover's)",
            "Quantum Circuit Design", "Qiskit Framework",
            "Quantum Error Correction",
            "Quantum Machine Learning",
            "Post-Quantum Cryptography"
        ],
    },
    {
        name: "UI/UX Design & Human-Computer Interaction",
        topics: [
            "User Research Methods", "Wireframing & Prototyping",
            "Figma & Adobe XD", "Usability Testing",
            "Interaction Design Principles",
            "Accessibility (WCAG)", "Information Architecture",
            "Design Systems", "Color Theory & Typography",
            "Motion Design", "User Journey Mapping",
            "A/B Testing for UX"
        ],
    },
];

async function seed() {
    try {
        await mongoose.connect(`${MONGO_URI}/${DB_NAME}`);
        console.log("Connected to MongoDB");

        const existing = await Elective.countDocuments();
        if (existing > 0) {
            console.log(`Elective collection already has ${existing} documents. Dropping and re-seeding...`);
            await Elective.deleteMany({});
        }

        const result = await Elective.insertMany(SEED_ELECTIVES);
        console.log(`✅ Seeded ${result.length} electives:`);
        result.forEach((e) => console.log(`   - ${e.name} (${e.topics.length} topics)`));
    } catch (err) {
        console.error("Seed failed:", err);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log("Disconnected from MongoDB");
    }
}

seed();
