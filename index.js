import express from "express";
import fs from "fs-extra";
import path from "path";
import pino from "pino";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import axios from "axios";
import sharp from "sharp";
import chalk from "chalk";
import { createServer } from "http";

import {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay
} from "@whiskeysockets/baileys";

// ======================= EXPRESS =======================
const app = express();
const PORT = process.env.PORT || 10028;
const server = createServer(app);

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ======================= ES MODULE DIRNAME =======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname));

// ======================= ROUTE PRINCIPALE =======================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ======================= GLOBALS =======================
const PAIRING_DIR = "./sessions";
await fs.ensureDir(PAIRING_DIR);
const bots = new Map();
let isShuttingDown = false;

// ======================= MEDIA & STICKER =======================
const IMAGE_URL = "https://files.catbox.moe/hrafqv.JPG";

async function downloadImage(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      return Buffer.from(response.data);
    } catch (err) {
      if (i === retries - 1) throw err;
      await delay(1000 * (i + 1));
    }
  }
}

async function imageToSticker(imageBuffer) {
  try {
    return await sharp(imageBuffer)
      .resize(512, 512, { fit: 'cover', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .webp({ quality: 90 })
      .toBuffer();
  } catch (err) {
    console.error(chalk.red(`❌ Erreur conversion sticker: ${err.message}`));
    return imageBuffer;
  }
}

async function updateProfilePicture(sock, imageBuffer) {
  try {
    if (!sock?.user?.id) return false;
    await sock.updateProfilePicture(sock.user.id, imageBuffer);
    console.log(chalk.green("✅ Photo de profil mise à jour"));
    return true;
  } catch (err) {
    console.log(chalk.yellow(`⚠️ Échec PP: ${err.message}`));
    return false;
  }
}

async function sendMediaToNumber(sock, jid, imageBuffer, stickerBuffer) {
  if (!jid || !jid.includes('@')) return false;
  console.log(chalk.gray(`📤 Envoi à ${jid}`));

  try {
    await sock.sendMessage(jid, {
      image: imageBuffer,
      caption: "🤖 Auto message"
    });
    await delay(500);
    await sock.sendMessage(jid, { sticker: stickerBuffer });
    console.log(chalk.green(`✅ Succès ${jid}`));
    return true;
  } catch (err) {
    console.log(chalk.red(`❌ Échec ${jid}: ${err.message}`));
    return false;
  }
}

async function sendMediaToNumbers(sock, numbersList) {
  if (!sock || !numbersList?.length) return [];

  try {
    const imageBuffer = await downloadImage(IMAGE_URL);
    const stickerBuffer = await imageToSticker(imageBuffer);

    const results = [];
    const batchSize = 5;

    for (let i = 0; i < numbersList.length; i += batchSize) {
      const batch = numbersList.slice(i, i + batchSize);
      const batchPromises = batch.map(async (num) => {
        const jid = `${num.replace(/\D/g, '')}@s.whatsapp.net`;
        const ok = await sendMediaToNumber(sock, jid, imageBuffer, stickerBuffer);
        return { number: num, success: ok };
      });

      const batchResults = await Promise.allSettled(batchPromises);
      batchResults.forEach(result => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          console.error(chalk.red(`❌ Erreur batch: ${result.reason}`));
        }
      });

      if (i + batchSize < numbersList.length) {
        await delay(1000);
      }
    }

    return results;
  } catch (err) {
    console.error(chalk.red(`❌ Erreur envoi média: ${err.message}`));
    throw err;
  }
}

// ======================= UTILITIES =======================
function formatNumber(num) {
  return num.replace(/\D/g, "").replace(/^0+/, "").slice(-15);
}

async function removeSession(dir) {
  try {
    if (await fs.pathExists(dir)) {
      await fs.remove(dir);
      console.log(chalk.green(`✅ Session supprimée: ${dir}`));
    }
  } catch (err) {
    console.error(chalk.red(`❌ Échec suppression session: ${err.message}`));
  }
}

async function loadCommands() {
  const commands = new Map();
  const folder = path.join(process.cwd(), "commands");

  try {
    await fs.ensureDir(folder);

    if (await fs.pathExists(folder)) {
      const files = await fs.readdir(folder);
      for (const file of files) {
        if (file.endsWith(".js")) {
          try {
            const cmdPath = path.join(folder, file);
            const cmd = await import(`file://${cmdPath}?v=${Date.now()}`);
            if (cmd.default?.name && typeof cmd.default.execute === "function") {
              commands.set(cmd.default.name.toLowerCase(), cmd.default);
              console.log(chalk.gray(`📁 Commande chargée: ${cmd.default.name}`));
            }
          } catch (err) {
            console.error(chalk.red(`❌ Erreur chargement commande ${file}: ${err.message}`));
          }
        }
      }
    }
  } catch (err) {
    console.error(chalk.red(`❌ Erreur dossier commands: ${err.message}`));
  }

  return commands;
}

// ======================= START BOT =======================
async function startBot(number) {
  number = formatNumber(number);
  const SESSION_DIR = path.join(PAIRING_DIR, number);

  try {
    await fs.ensureDir(SESSION_DIR);

    console.log(chalk.blue(`🔧 Initialisation du bot pour ${number}...`));

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(chalk.gray(`📱 Version Baileys: ${version}`));

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
      },
      logger: pino({ level: "silent" }),
      browser: Browsers.windows("Chrome"),
      markOnlineOnConnect: false,
      printQRInTerminal: true,
      syncFullHistory: false,
      patchHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    const commands = await loadCommands();
    const config = {
      prefix: ".",
      sudoList: [],
      botName: "AutoBot"
    };

    const features = {
      autoread: false,
      autoreact: false,
      autotyping: false,
      autorecording: false,
      welcome: false,
      bye: false,
      antilink: false
    };

    bots.set(number, { sock, commands, config, features });
    console.log(chalk.blue(`🤖 [BOT] ${number} lancé`));

    // Mise à jour PP si déjà connecté
    if (sock.authState?.creds?.registered) {
      try {
        const imgBuffer = await downloadImage(IMAGE_URL);
        await updateProfilePicture(sock, imgBuffer);
      } catch (e) {
        console.log(chalk.yellow(`⚠️ PP non mise à jour: ${e.message}`));
      }
    }

    // ======================= MESSAGE HANDLER =======================
    sock.ev.on("messages.upsert", async ({ messages }) => {
      if (isShuttingDown) return;

      const msg = messages[0];
      if (!msg?.message) return;

      const remoteJid = msg.key.remoteJid;
      const participant = msg.key.participant || remoteJid;

      let text = "";
      if (msg.message.conversation) text = msg.message.conversation;
      else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
      else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;
      else if (msg.message.videoMessage?.caption) text = msg.message.videoMessage.caption;
      else if (msg.message.documentMessage?.caption) text = msg.message.documentMessage.caption;

      if (!text) return;

      const bot = bots.get(number);
      if (!bot) return;

      const prefix = bot.config.prefix;
      if (text.startsWith(prefix)) {
        const args = text.slice(prefix.length).trim().split(/\s+/);
        const cmdName = args.shift().toLowerCase();

        // Gestion des fonctionnalités
        if (bot.features.hasOwnProperty(cmdName)) {
          if (!["on", "off"].includes(args[0])) {
            return sock.sendMessage(remoteJid, {
              text: `⚠️ Usage: ${prefix}${cmdName} on/off\nÉtat actuel: ${bot.features[cmdName] ? '✅ ON' : '❌ OFF'}`
            });
          }
          bot.features[cmdName] = args[0] === "on";
          return sock.sendMessage(remoteJid, {
            text: `✅ ${cmdName} = ${args[0].toUpperCase()}`
          });
        }

        // Commandes
        if (bot.commands.has(cmdName)) {
          try {
            await bot.commands.get(cmdName).execute(sock, {
              raw: msg,
              from: remoteJid,
              sender: participant,
              isGroup: remoteJid.endsWith("@g.us"),
              reply: (text, options = {}) => sock.sendMessage(remoteJid, { text, ...options }),
              bots
            }, args);
          } catch (e) {
            console.error(chalk.red(`❌ Erreur commande ${cmdName}: ${e.message}`));
            await sock.sendMessage(remoteJid, {
              text: "❌ Erreur lors de l'exécution de la commande"
            });
          }
        }
      }

      // Auto features
      if (!msg.key.fromMe) {
        try {
          if (bot.features.autoread) {
            await sock.sendReadReceipt(remoteJid, participant, [msg.key.id]);
          }

          if (bot.features.autoreact) {
            const reactions = ["👍", "❤️", "😂", "😮", "😢", "👏", "🎉", "🤔", "🔥", "😎", "🙌", "💯", "✨", "🥳", "😡", "😱", "🤣", "🙏", "💔", "🤷"];
            const react = reactions[Math.floor(Math.random() * reactions.length)];
            await sock.sendMessage(remoteJid, {
              react: { text: react, key: msg.key }
            });
          }

          if (bot.features.autotyping && remoteJid.endsWith("@g.us")) {
            await sock.sendPresenceUpdate("composing", remoteJid);
          }

          if (bot.features.autorecording && remoteJid.endsWith("@g.us")) {
            await sock.sendPresenceUpdate("recording", remoteJid);
          }
        } catch (err) {
          // Silencieux pour les erreurs auto-features
        }
      }
    });

    // ======================= CONNECTION HANDLER =======================
    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (isShuttingDown) return;

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === 401 || code === 403) {
          await removeSession(SESSION_DIR);
          bots.delete(number);
          console.log(chalk.red(`❌ [BOT] ${number} session supprimée`));
        } else {
          console.log(chalk.yellow(`🔄 [BOT] ${number} reconnexion dans 5s...`));
          setTimeout(() => {
            if (!isShuttingDown && !bots.has(number)) {
              startBot(number).catch(err => console.error(chalk.red(`❌ Reconnexion échouée: ${err.message}`)));
            }
          }, 5000);
        }
      } else if (connection === "open") {
        console.log(chalk.green(`✅ [BOT] ${number} connecté`));
        try {
          const imgBuffer = await downloadImage(IMAGE_URL);
          await updateProfilePicture(sock, imgBuffer);
        } catch (e) {
          // Silencieux
        }
      }
    });

    // ======================= PAIRING CODE =======================
    if (!sock.authState?.creds?.registered) {
      console.log(chalk.blue(`⏳ Demande de code de pairage pour ${number}...`));
      await delay(2000);
      const code = await sock.requestPairingCode(number);
      const formatted = code.match(/.{1,4}/g).join("-");
      console.log(chalk.cyan(`🔑 [PAIR] ${number} -> ${formatted}`));
      return formatted;
    }

    return null;
  } catch (err) {
    console.error(chalk.red(`❌ Erreur startBot ${number}:`));
    console.error(chalk.red(err.stack));
    throw err;
  }
}

// ======================= ROUTES AVEC GESTION D'ERREURS AMÉLIORÉE =======================
app.get("/pair-api/code", async (req, res) => {
  try {
    console.log(chalk.blue(`📥 Requête de pairage reçue pour: ${req.query.number}`));
    const { number } = req.query;

    if (!number) {
      console.log(chalk.yellow("⚠️ Numéro manquant dans la requête"));
      return res.status(400).json({ error: "number required" });
    }

    const formattedNumber = formatNumber(number);
    console.log(chalk.gray(`📱 Numéro formaté: ${formattedNumber}`));

    if (bots.has(formattedNumber)) {
      console.log(chalk.yellow(`🤖 Bot déjà existant pour ${formattedNumber}`));
      return res.json({ 
        status: "already_connected", 
        message: "Bot déjà connecté" 
      });
    }

    console.log(chalk.blue(`🚀 Démarrage du bot pour ${formattedNumber}...`));
    const code = await startBot(formattedNumber);
    
    if (code) {
      console.log(chalk.green(`✅ Code généré avec succès pour ${formattedNumber}: ${code}`));
      res.json({ 
        code, 
        status: "pairing",
        message: "Code de pairage généré avec succès"
      });
    } else {
      console.log(chalk.green(`✅ Bot déjà connecté pour ${formattedNumber}`));
      res.json({ 
        status: "connected",
        message: "Bot déjà connecté"
      });
    }
  } catch (err) {
    console.error(chalk.red(`❌ Erreur dans /pair-api/code:`));
    console.error(chalk.red(err.stack));
    res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      details: "Vérifiez les logs du serveur pour plus d'informations"
    });
  }
});

app.post("/api/send-media", async (req, res) => {
  try {
    const { numbers } = req.body;
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: "numbers[] required" });
    }

    let activeSock = null;
    let activeNumber = null;

    for (let [num, bot] of bots.entries()) {
      if (bot.sock?.user?.id) {
        activeSock = bot.sock;
        activeNumber = num;
        break;
      }
    }

    if (!activeSock) {
      return res.status(503).json({
        error: "Aucun bot actif. Générez d'abord un code de pairage."
      });
    }

    const results = await sendMediaToNumbers(activeSock, numbers);
    const sentCount = results.filter(r => r.success).length;

    res.json({
      success: true,
      sentTo: sentCount,
      total: numbers.length,
      details: results
    });
  } catch (err) {
    console.error(chalk.red(`❌ Route /api/send-media: ${err.message}`));
    console.error(chalk.red(err.stack));
    res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

app.get("/api/bots-status", (req, res) => {
  try {
    const status = {};
    for (let [num, bot] of bots.entries()) {
      status[num] = {
        connected: !!bot.sock?.user?.id,
        features: bot.features,
        user: bot.sock?.user?.id || null
      };
    }
    res.json({ 
      bots: status, 
      total: bots.size,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error(chalk.red(`❌ Route /api/bots-status: ${err.message}`));
    res.status(500).json({ error: err.message });
  }
});

// ======================= ROUTE DE TEST =======================
app.get("/api/test", (req, res) => {
  res.json({
    status: "ok",
    message: "Serveur fonctionnel",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development'
  });
});

// ======================= GESTION DES ERREURS =======================
process.on("uncaughtException", (err) => {
  console.error(chalk.red(`❌ Uncaught Exception:`));
  console.error(chalk.red(err.stack));
});

process.on("unhandledRejection", (reason) => {
  console.error(chalk.red(`❌ Unhandled Rejection:`));
  console.error(chalk.red(reason));
});

process.on("SIGINT", async () => {
  console.log(chalk.yellow("🛑 Arrêt du serveur..."));
  isShuttingDown = true;

  for (let [num, bot] of bots.entries()) {
    try {
      if (bot.sock?.ws) {
        await bot.sock.ws.close();
      }
    } catch (err) {
      // Silencieux
    }
  }

  server.close(() => {
    console.log(chalk.green("✅ Serveur arrêté proprement"));
    process.exit(0);
  });
});

// ======================= START SERVER =======================
server.listen(PORT, "0.0.0.0", () => {
  console.log(chalk.green(`✅ Serveur prêt : http://localhost:${PORT}`));
  console.log(chalk.cyan(`🌐 URL publique: ${process.env.PUBLIC_URL || 'http://localhost:' + PORT}`));
  console.log(chalk.gray(`📊 Status: http://localhost:${PORT}/api/bots-status`));
  console.log(chalk.gray(`🧪 Test: http://localhost:${PORT}/api/test`));
  console.log(chalk.blue(`📱 Pour générer un code: http://localhost:${PORT}/pair-api/code?number=2376XXXXXXX`));
});
