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
    secure: false, // Changed: disable secure in development, Railway should handle HTTPS
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

await mongoose.connect(process.env.MONGO_URI, { dbName: "hockey" });

const ChampagneMoment = new mongoose.Schema({ text: String }, { _id: true });

const Player = mongoose.model(
  "Player",
  new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now },
  })
);

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

// ========== API ROUTES - MUST COME BEFORE STATIC FILES ==========

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
  console.log("Login attempt received");
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  
  console.log("Comparing passwords (lengths):", password?.length, "vs", adminPassword?.length);
  
  if (password === adminPassword) {
    req.session.isAdmin = true;
    console.log("Login successful, session set");
    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).json({ error: "Session save failed" });
      }
      res.json({ success: true });
    });
  } else {
    console.log("Login failed - invalid password");
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

// Create game
app.post("/api/games", async (req, res) => {
  try {
    console.log("Received game creation request:", req.body);
    const { date, opponents, teamName = "Weysiders", clubName = "Guildford Hockey Club", teamSheet = [], champagneMoments = [] } = req.body;
    
    if (!date || !opponents || !teamSheet.length) {
      console.log("Validation failed:", { date: !!date, opponents: !!opponents, teamSheetLength: teamSheet.length });
      return res.status(400).json({ error: "Missing required fields: date, opponents, and team sheet" });
    }
    
    // Add players to master list (without duplicates)
    for (const playerName of teamSheet) {
      try {
        await Player.findOneAndUpdate(
          { name: playerName },
          { name: playerName },
          { upsert: true, new: true }
        );
      } catch (err) {
        // Ignore duplicate key errors
        if (err.code !== 11000) {
          console.error("Error adding player:", playerName, err);
        }
      }
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

// Get game by ID
app.get("/api/games/:id", async (req, res) => {
  const g = await Game.findById(req.params.id);
  if (!g) return res.status(404).json({ error: "Game not found" });
  res.json(g);
});

// Submit vote
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

// Get game results
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

// Get master player list
app.get("/api/players", async (req, res) => {
  try {
    const players = await Player.find().sort({ name: 1 });
    res.json(players.map(p => p.name));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get open games for a specific player
app.get("/api/games/player/:playerName", async (req, res) => {
  try {
    const playerName = decodeURIComponent(req.params.playerName);
    const games = await Game.find({ 
      status: "open",
      teamSheet: playerName 
    }).sort({ date: -1 });
    res.json(games);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoints - all require authentication
app.get("/api/admin/players", requireAuth, async (req, res) => {
  try {
    const players = await Player.find().sort({ name: 1 });
    res.json(players);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/admin/players/:id", requireAuth, async (req, res) => {
  try {
    await Player.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoints - all require authentication
app.get("/api/admin/games", requireAuth, async (req, res) => {
  try {
    const games = await Game.find().sort({ createdAt: -1 });
    const gamesWithStats = await Promise.all(
      games.map(async (g) => {
        const voteCount = await Vote.countDocuments({ gameId: g._id });
        return {
          _id: g._id,
          date: g.date,
          opponents: g.opponents,
          teamName: g.teamName,
          status: g.status,
          createdAt: g.createdAt,
          voteCount
        };
      })
    );
    res.json(gamesWithStats);
  } catch (error) {
    console.error("Error loading games:", error);
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/admin/games/:id/close", requireAuth, async (req, res) => {
  const g = await Game.findByIdAndUpdate(
    req.params.id,
    { status: "closed" },
    { new: true }
  );
  if (!g) return res.status(404).json({ error: "Game not found" });
  res.json(g);
});

app.patch("/api/admin/games/:id/reopen", requireAuth, async (req, res) => {
  const g = await Game.findByIdAndUpdate(
    req.params.id,
    { status: "open" },
    { new: true }
  );
  if (!g) return res.status(404).json({ error: "Game not found" });
  res.json(g);
});

app.delete("/api/admin/games/:id", requireAuth, async (req, res) => {
  await Vote.deleteMany({ gameId: req.params.id });
  await Game.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ========== STATIC FILES & CATCH-ALL - MUST COME LAST ==========
app.use(express.static(path.join(__dirname, "public")));

// Catch-all route - only for non-API routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});