import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import expressSession from "express-session";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(morgan("tiny"));
app.use(cors({ 
  origin: process.env.CORS_ORIGIN || true,
  credentials: true 
}));

// Session middleware for admin authentication
app.use(expressSession({
  secret: process.env.SESSION_SECRET || 'hockey-voting-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

await mongoose.connect(process.env.MONGO_URI, { dbName: "hockey" });

const ChampagneMoment = new mongoose.Schema({ text: String }, { _id: true });
const Game = mongoose.model(
  "Game",
  new mongoose.Schema({
    date: String,
    opponents: String,
    teamName: { type: String, default: "Weysiders" },
    clubName: { type: String, default: "Guildford Hockey Club" },
    teamSheet: [String],
    champagneMoments: [ChampagneMoment],
    status: { type: String, default: "open", enum: ["open", "closed"] },
    createdAt: { type: Date, default: Date.now },
  })
);

const Vote = mongoose.model(
  "Vote",
  new mongoose.Schema({
    gameId: mongoose.Types.ObjectId,
    voter: { name: String, token: String },
    mom: { player: String, comment: String },
    dod: { player: String, comment: String },
    champagneMoment: { eventId: mongoose.Types.ObjectId, textIfNew: String },
  })
);

app.get("/api/health", (_, r) => r.json({ ok: true }));

// Admin authentication middleware
function requireAuth(req, res, next) {
  if (req.session.isAdmin) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}

// Admin login
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  
  if (password === adminPassword) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Admin logout
app.post("/api/admin/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check admin session
app.get("/api/admin/check", (req, res) => {
  res.json({ isAuthenticated: !!req.session.isAdmin });
});

app.post("/api/games", async (req, res) => {
  try {
    console.log("Received game creation request:", req.body);
    const { date, opponents, teamName = "Weysiders", clubName = "Guildford Hockey Club", teamSheet = [], champagneMoments = [] } = req.body;
    
    if (!date || !opponents || !teamSheet.length) {
      console.log("Validation failed:", { date: !!date, opponents: !!opponents, teamSheetLength: teamSheet.length });
      return res.status(400).json({ error: "Missing required fields: date, opponents, and team sheet" });
    }
    
    const game = await Game.create({
      date,
      opponents,
      teamName,
      clubName,
      teamSheet,
      champagneMoments: champagneMoments.map((t) => ({ text: t })),
    });
    
    console.log("Game created successfully:", game._id);
    res.json(game);
  } catch (error) {
    console.error("Error creating game:", error);
    res.status(500).json({ error: error.message || "Failed to create game" });
  }
});

app.get("/api/games/:id", async (req, res) => {
  const g = await Game.findById(req.params.id);
  if (!g) return res.status(404).json({ error: "Game not found" });
  res.json(g);
});

app.post("/api/games/:id/votes", async (req, res) => {
  try {
    const g = await Game.findById(req.params.id);
    if (!g) return res.status(404).json({ error: "Game not found" });
    
    // Check if game is closed
    if (g.status === "closed") {
      return res.status(403).json({ error: "This match is closed. Voting has ended." });
    }

    // Handle new champagne moment
    if (req.body.champagneMoment?.textIfNew) {
      const newMoment = { text: req.body.champagneMoment.textIfNew };
      g.champagneMoments.push(newMoment);
      await g.save();
      req.body.champagneMoment.eventId = g.champagneMoments[g.champagneMoments.length - 1]._id;
      delete req.body.champagneMoment.textIfNew;
    }

    const v = await Vote.create({ ...req.body, gameId: g._id });
    res.json(v);
  } catch (e) {
    if (e.code === 11000)
      return res.status(409).json({ error: "Already voted" });
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/games/:id/results", async (req, res) => {
  const g = await Game.findById(req.params.id);
  const votes = await Vote.find({ gameId: g._id });
  
  const tally = (field) =>
    Object.entries(
      votes.reduce((m, v) => ((m[v[field].player] = (m[v[field].player] || 0) + 1), m), {})
    )
    .map(([player, count]) => ({ player, count }))
    .sort((a, b) => b.count - a.count);

  // Tally champagne moments
  const champagneTally = {};
  votes.forEach(v => {
    if (v.champagneMoment?.eventId) {
      const eventId = v.champagneMoment.eventId.toString();
      champagneTally[eventId] = (champagneTally[eventId] || 0) + 1;
    }
  });

  const champagneMoments = g.champagneMoments.map(cm => ({
    _id: cm._id,
    text: cm.text,
    votes: champagneTally[cm._id.toString()] || 0
  })).sort((a, b) => b.votes - a.votes);

  res.json({ 
    game: g, 
    totals: { mom: tally("mom"), dod: tally("dod") },
    champagneMoments
  });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(process.env.PORT || 8080);