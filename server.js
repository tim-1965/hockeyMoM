import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(morgan('tiny'));
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

const mongoUri = process.env.MONGO_URI;
if (!mongoUri) console.error('Missing MONGO_URI');
await mongoose.connect(mongoUri, { dbName: 'hockey' });

const StandoutEventSchema = new mongoose.Schema({ text: { type: String, required: true } }, { _id: true });
const GameSchema = new mongoose.Schema({
  date: { type: String, required: true },
  opponents: { type: String, required: true },
  teamName: { type: String, default: 'Weysiders' },
  clubName: { type: String, default: 'Guildford Hockey Club' },
  teamSheet: { type: [String], required: true },
  standoutEvents: { type: [StandoutEventSchema], default: [] }
}, { timestamps: true });

const VoteSchema = new mongoose.Schema({
  gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game', required: true },
  voter: { name: String, token: { type: String, required: true } },
  mom: { player: { type: String, required: true }, comment: { type: String, default: '' } },
  dod: { player: { type: String, required: true }, comment: { type: String, default: '' } },
  standout: { eventId: mongoose.Schema.Types.ObjectId, textIfNew: String }
}, { timestamps: { createdAt: true, updatedAt: false } });

VoteSchema.index({ gameId: 1, 'voter.token': 1 }, { unique: true });

const Game = mongoose.model('Game', GameSchema);
const Vote = mongoose.model('Vote', VoteSchema);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/games', async (req, res) => {
  try {
    const { date, opponents, teamName = 'Weysiders', clubName = 'Guildford Hockey Club', teamSheet = [], standoutEvents = [] } = req.body;
    if (!date || !opponents || !teamSheet.length) return res.status(400).json({ error: 'date, opponents, and teamSheet are required' });
    const evs = standoutEvents.filter(Boolean).map(text => ({ text }));
    const game = await Game.create({ date, opponents, teamName, clubName, teamSheet, standoutEvents: evs });
    res.json(game);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const game = await Game.findById(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json(game);
  } catch { res.status(400).json({ error: 'Invalid game id' }); }
});

app.post('/api/games/:id/votes', async (req, res) => {
  try {
    const { voter = {}, mom, dod, standout } = req.body;
    const game = await Game.findById(req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (!mom?.player || !dod?.player) return res.status(400).json({ error: 'mom.player and dod.player required' });
    const inTeam = (p) => game.teamSheet.includes(p);
    if (!inTeam(mom.player) || !inTeam(dod.player)) return res.status(400).json({ error: 'Selected players must be on the team sheet' });
    let eventId = standout?.eventId || null;
    if (!eventId && standout?.textIfNew) {
      game.standoutEvents.push({ text: standout.textIfNew });
      await game.save();
      eventId = game.standoutEvents.at(-1)._id;
    }
    const vote = await Vote.create({
      gameId: game._id,
      voter: { name: voter.name || '', token: voter.token },
      mom: { player: mom.player, comment: mom.comment || '' },
      dod: { player: dod.player, comment: dod.comment || '' },
      standout: { eventId, textIfNew: standout?.textIfNew || '' }
    });
    res.json(vote);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'You have already voted for this game.' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/games/:id/results', async (req, res) => {
  try {
    const game = await Game.findById(req.params.id);
    const votes = await Vote.find({ gameId: game._id });
    const tally = (field) => {
      const map = new Map();
      for (const v of votes) {
        const key = v[field].player;
        map.set(key, (map.get(key) || 0) + 1);
      }
      return [...map.entries()].sort((a,b)=>b[1]-a[1]).map(([player,count])=>({player,count}));
    };
    const standoutCounts = new Map();
    for (const v of votes) {
      const id = v.standout.eventId?.toString();
      if (!id) continue;
      standoutCounts.set(id, (standoutCounts.get(id) || 0) + 1);
    }
    const standout = game.standoutEvents.map(ev => ({
      _id: ev._id, text: ev.text, votes: standoutCounts.get(ev._id.toString()) || 0
    })).sort((a,b)=>b.votes-a.votes);
    const comments = {
      mom: votes.filter(v=>v.mom.comment?.trim()).map(v=>({ player: v.mom.player, comment: v.mom.comment, voter: v.voter.name })).slice(-50),
      dod: votes.filter(v=>v.dod.comment?.trim()).map(v=>({ player: v.dod.player, comment: v.dod.comment, voter: v.voter.name })).slice(-50)
    };
    res.json({ game: { _id: game._id, date: game.date, opponents: game.opponents, teamName: game.teamName, clubName: game.clubName }, totals: { mom: tally('mom'), dod: tally('dod'), standout }, comments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Listening on', port));
