import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(morgan("tiny"));
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

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

app.post("/api/games", async (req, res) => {
  const { date, opponents, teamSheet = [], champagneMoments = [] } = req.body;
  if (!date || !opponents || !teamSheet.length)
    return res.status(400).json({ error: "Missing fields" });
  const game = await Game.create({
    date,
    opponents,
    teamSheet,
    champagneMoments: champagneMoments.map((t) => ({ text: t })),
  });
  res.json(game);
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