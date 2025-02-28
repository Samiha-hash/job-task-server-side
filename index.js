const express = require("express");
require("dotenv").config();
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const morgan = require("morgan");
const { createServer } = require("http");
const { Server } = require("socket.io");

const port = process.env.PORT || 5000;
const app = express();
const httpServer = createServer(app);

// Middleware
const corsOptions = {
    origin: ["https://job-task-cb3d2.web.app", "http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-requested-with"],
    exposedHeaders: ["set-cookie"],
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

const io = new Server(httpServer, { cors: corsOptions });

// MongoDB Connection
const uri = "mongodb+srv://spider:SzvmPr64wMXiip0V@cluster0.p0tuu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    maxPoolSize: 10,
    connectTimeoutMS: 5000,
    retryWrites: true,
    retryReads: true,
});

let db, usersCollection, taskCollection;

async function connectToDatabase() {
    try {
        await client.connect();
        db = client.db("TaskMateDB");
        usersCollection = db.collection("users");
        taskCollection = db.collection("taskCollection");
        console.log("Connected to database...");
    } catch (error) {
        console.error("Database connection failed:", error);
    }
}
connectToDatabase();

async function ensureDBConnection(req, res, next) {
    if (!taskCollection || !usersCollection) {
        try {
            await connectToDatabase();
        } catch (error) {
            return res.status(500).json({ error: "Failed to connect to the database." });
        }
    }
    next();
}
app.use(ensureDBConnection);

// Middleware to verify JWT
const verifyToken = (req, res, next) => {
    const token = req.cookies?.token;
    if (!token) return res.status(401).send({ message: "Unauthorized access" });
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) return res.status(401).send({ message: "Unauthorized access" });
        req.decoded = decoded;
        next();
    });
};

const validateObjectId = (req, res, next) => {
    const { id } = req.params;
    if (!id || !ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid task ID", details: "Task ID must be a valid MongoDB ObjectId" });
    }
    next();
};

// Authentication Routes
app.post("/jwt", async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: "Email is required" });
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "365d" });
        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
            path: "/",
        }).json({ success: true });
    } catch (error) {
        console.error("JWT Error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

app.get("/logout", async (req, res) => {
    try {
        res.clearCookie("token", {
            httpOnly: true,
            maxAge: 0,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        }).send({ success: true });
    } catch (err) {
        res.status(500).send(err);
    }
});

// User Routes
app.post("/users", async (req, res) => {
    const user = req.body;
    const exist = await usersCollection.findOne({ email: user.email });
    if (exist) return res.send({ message: "User already exists", insertedId: null });
    const result = await usersCollection.insertOne(user);
    res.send(result);
});

app.get("/users", async (req, res) => res.send(await usersCollection.find().toArray()));

// Task Routes
app.get("/tasks/:email", verifyToken, async (req, res) => {
    const { email } = req.params;
    const tasks = await taskCollection.find({ userId: email }).toArray();
    res.send(tasks);
});

app.post("/tasks", verifyToken, async (req, res) => {
    const { title, description, category } = req.body;
    if (!title || title.length > 50) return res.status(400).json({ error: "Invalid title" });
    if (description && description.length > 200) return res.status(400).json({ error: "Description too long" });
    const newTask = { userId: req.decoded.email, title, description, category: category || "To-Do", createdAt: new Date() };
    const result = await taskCollection.insertOne(newTask);
    io.emit(`task-updated-${req.decoded.email}`);
    res.json({ ...newTask, _id: result.insertedId });
});

app.put("/tasks/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const updateFields = req.body;
    const result = await taskCollection.updateOne({ _id: new ObjectId(id), userId: req.decoded.email }, { $set: updateFields });
    if (result.matchedCount === 0) return res.status(404).json({ error: "Task not found" });
    io.emit(`task-updated-${req.decoded.email}`);
    res.json({ message: "Task updated", taskId: id });
});


// PATCH Task Route (Fix Applied)
app.patch("/tasks/:id", verifyToken, validateObjectId, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, category } = req.body;
        const updateFields = {};

        if (title && title.length <= 50) updateFields.title = title;
        if (description && description.length <= 200) updateFields.description = description;
        if (category) updateFields.category = category;

        const result = await taskCollection.updateOne(
            { _id: new ObjectId(id), userId: req.decoded.email },
            { $set: updateFields }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                error: "Task not found",
                details: `No task found with ID: ${id} for user: ${req.decoded.email}`,
            });
        }

        io.emit(`task-updated-${req.decoded.email}`);
        res.json({
            message: "Task updated",
            taskId: id,
            updatedFields: updateFields,
        });
    } catch (error) {
        console.error("Error updating task:", error);
        res.status(500).json({
            error: "Internal server error",
            details: error.message,
        });
    }
});

app.delete("/tasks/:id", verifyToken, async (req, res) => {
    await taskCollection.deleteOne({ _id: new ObjectId(req.params.id), userId: req.decoded.email });
    io.emit(`task-updated-${req.decoded.email}`);
    res.json({ message: "Task deleted" });
});

// Socket.IO connection handling
io.on("connection", (socket) => {
    console.log("Client connected");
    socket.on("join-room", (userId) => socket.join(userId));
    socket.on("disconnect", () => console.log("Client disconnected"));
});

app.get("/", (req, res) => res.send("Hurray! My server is running."));

httpServer.listen(port, () => console.log(`Server running on port ${port}`));