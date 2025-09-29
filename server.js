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

const voteSchema = new mongoose.Schema(
  {
    gameId: { type: mongoose.Schema.Types.ObjectId, required: true },
    voter: {
      name: { type: String, required: true },
      token: { type: String, required: true },
    },
    mom: {
      player: String,
      comment: String,
    },
    dod: {
      player: String,
      comment: String,
    },
    champagneMoment: {
      eventId: mongoose.Schema.Types.ObjectId,
      comment: String,
    },
  },
  { timestamps: true }
);

voteSchema.index({ gameId: 1, "voter.token": 1 }, { unique: true });

const Vote = mongoose.model("Vote", voteSchema);

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
   const game = await Game.findById(req.params.id);
    if (!game) return res.status(404).json({ error: "Game not found" });

    if (game.status === "closed") {
      return res.status(403).json({ error: "This match is closed. Voting has ended." });
    }

    const { voter, mom, dod, champagneMoment } = req.body || {};
    const voterName = typeof voter?.name === "string" ? voter.name.trim() : "";
    if (!voter?.token || !voterName) {
      return res.status(400).json({ error: "Missing voter information" });
    }

    const formatNomination = (entry) => {
      if (!entry) return null;
      const player = typeof entry.player === "string" ? entry.player.trim() : "";
      if (!player) return null;
      const comment = typeof entry.comment === "string" ? entry.comment.trim() : "";
      return { player, comment };
    };

    const updateDoc = {
      $set: {
        voter: { name: voterName, token: voter.token },
        gameId: game._id,
      },
    };

    const unsetDoc = {};

    if (mom !== undefined) {
      const momVote = formatNomination(mom);
      if (momVote) {
        updateDoc.$set.mom = momVote;
      } else {
        unsetDoc.mom = "";
      }
    }

    if (dod !== undefined) {
      const dodVote = formatNomination(dod);
      if (dodVote) {
        updateDoc.$set.dod = dodVote;
      } else {
        unsetDoc.dod = "";
      }
    }

    if (champagneMoment !== undefined) {
      const champagneUpdate = {};

      const newText =
        typeof champagneMoment.textIfNew === "string"
          ? champagneMoment.textIfNew.trim()
          : "";
      if (newText) {
        const newMoment = { text: newText };
        game.champagneMoments.push(newMoment);
        await game.save();
        champagneUpdate.eventId =
          game.champagneMoments[game.champagneMoments.length - 1]._id;
      }

      if (champagneMoment.eventId) {
        champagneUpdate.eventId = champagneMoment.eventId;
      }

      if (champagneMoment.comment !== undefined) {
        champagneUpdate.comment =
          typeof champagneMoment.comment === "string"
            ? champagneMoment.comment.trim()
            : "";
      }

      if (champagneUpdate.eventId) {
        if (!("comment" in champagneUpdate)) {
          champagneUpdate.comment = "";
        }
        updateDoc.$set.champagneMoment = champagneUpdate;
      } else {
        unsetDoc.champagneMoment = "";
      }
    }

    if (Object.keys(unsetDoc).length) {
      updateDoc.$unset = unsetDoc;
    }

     const vote = await Vote.findOneAndUpdate(
      { gameId: game._id, "voter.token": voter.token },
      updateDoc,
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
    );

    res.json(vote);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ error: "Already voted" });
    }
    res.status(500).json({ error: e.message || "Failed to submit vote" });
  }
});

// Get game results
app.get("/api/games/:id/results", async (req, res) => {
 const game = await Game.findById(req.params.id);
  if (!game) {
    return res.status(404).json({ error: "Game not found" });
  }

  const votes = await Vote.find({ gameId: game._id });

  const buildTally = (field) => {
    const resultsMap = new Map();
    for (const vote of votes) {
      const entry = vote[field];
      const player = entry?.player;
      if (!player) continue;
      const trimmedComment =
        typeof entry.comment === "string" ? entry.comment.trim() : "";

      if (!resultsMap.has(player)) {
        resultsMap.set(player, { player, count: 0, comments: [] });
      }

      const data = resultsMap.get(player);
      data.count += 1;
      if (trimmedComment) {
        data.comments.push(trimmedComment);
      }
    }

  return Array.from(resultsMap.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.player.localeCompare(b.player);
    });
  };

  const champagneResults = game.champagneMoments.map((moment) => ({
    _id: moment._id,
    text: moment.text,
    votes: 0,
    comments: [],
  }));

  const champagneMap = new Map(
    champagneResults.map((moment) => [moment._id.toString(), moment])
  );

  for (const vote of votes) {
    const selection = vote.champagneMoment;
    const eventId = selection?.eventId?.toString();
    if (!eventId) continue;
    const entry = champagneMap.get(eventId);
    if (!entry) continue;

    entry.votes += 1;

    const trimmedComment =
      typeof selection.comment === "string" ? selection.comment.trim() : "";
    if (trimmedComment) {
      entry.comments.push(trimmedComment);
    }
  }

  const sortedChampagneMoments = Array.from(champagneMap.values()).sort(
    (a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      return a.text.localeCompare(b.text);
    }
  );

  const token = req.query.token;
  const userVote = token
    ? votes.find((vote) => vote.voter?.token === token)
    : null;

  const userVotes = userVote
    ? {
        mom: userVote.mom?.player
          ? {
              player: userVote.mom.player,
              comment: userVote.mom.comment || "",
            }
          : null,
        dod: userVote.dod?.player
          ? {
              player: userVote.dod.player,
              comment: userVote.dod.comment || "",
            }
          : null,
        champagne: userVote.champagneMoment?.eventId
          ? {
              eventId: userVote.champagneMoment.eventId.toString(),
              comment: userVote.champagneMoment.comment || "",
              text:
                champagneMap.get(
                  userVote.champagneMoment.eventId.toString()
                )?.text || "",
            }
          : null,
      }
    : {};

   res.json({
    game,
    totals: { mom: buildTally("mom"), dod: buildTally("dod") },
    champagneMoments: sortedChampagneMoments,
    userVotes,
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