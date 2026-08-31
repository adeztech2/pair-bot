import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const logger = P({
  level: "silent"
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

let sock = null;

let currentQR = null;
let currentQRImage = null;
let pairingCode = null;
let connectionStatus = "disconnected";
let lastPhoneNumber = null;

let reconnecting = false;

/*
|--------------------------------------------------------------------------
| Start WhatsApp
|--------------------------------------------------------------------------
*/

async function startWhatsApp() {
  try {
    const { state, saveCreds } =
      await useMultiFileAuthState("./session");

    sock = makeWASocket({
      auth: state,

      browser: Browsers.ubuntu("Chrome"),

      logger,

      markOnlineOnConnect: false,

      printQRInTerminal: false
    });

    /*
    |--------------------------------------------------------------------------
    | Save credentials
    |--------------------------------------------------------------------------
    */

    sock.ev.on("creds.update", saveCreds);

    /*
    |--------------------------------------------------------------------------
    | Connection updates
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        /*
        |--------------------------------------------------------------------------
        | QR CODE
        |--------------------------------------------------------------------------
        */

        if (qr) {
          try {
            currentQR = qr;

            currentQRImage = await QRCode.toDataURL(qr, {
              width: 320,
              margin: 2
            });

            connectionStatus = "waiting_for_qr";

            console.log("New ADEZ-MD QR code generated.");
          } catch (error) {
            console.error("QR generation error:", error);
          }
        }

        /*
        |--------------------------------------------------------------------------
        | Connected
        |--------------------------------------------------------------------------
        */

        if (connection === "open") {
          connectionStatus = "connected";

          currentQR = null;
          currentQRImage = null;
          pairingCode = null;

          console.log("ADEZ-MD connected to WhatsApp.");
        }

        /*
        |--------------------------------------------------------------------------
        | Connecting
        |--------------------------------------------------------------------------
        */

        if (connection === "connecting") {
          connectionStatus = "connecting";
        }

        /*
        |--------------------------------------------------------------------------
        | Disconnected
        |--------------------------------------------------------------------------
        */

        if (connection === "close") {
          currentQR = null;
          currentQRImage = null;

          const statusCode =
            new Boom(lastDisconnect?.error)?.output?.statusCode;

          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut;

          connectionStatus = "disconnected";

          console.log(
            "WhatsApp disconnected.",
            "Status:",
            statusCode,
            "Reconnect:",
            shouldReconnect
          );

          if (shouldReconnect && !reconnecting) {
            reconnecting = true;

            setTimeout(async () => {
              reconnecting = false;
              await startWhatsApp();
            }, 3000);
          }
        }
      }
    );

    /*
    |--------------------------------------------------------------------------
    | Basic message handler
    |--------------------------------------------------------------------------
    |
    | This is only a simple test response.
    | You can replace it later with your complete ADEZ-MD bot.
    |
    */

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {
        try {
          const message = messages[0];

          if (!message) return;

          if (message.key.fromMe) return;

          if (!message.message) return;

          const jid = message.key.remoteJid;

          if (!jid) return;

          const text =
            message.message.conversation ||
            message.message.extendedTextMessage?.text ||
            "";

          if (text.toLowerCase() === ".ping") {
            await sock.sendMessage(jid, {
              text: "🏓 ADEZ-MD is online!"
            });
          }

        } catch (error) {
          console.error("Message error:", error);
        }
      }
    );

  } catch (error) {
    console.error("WhatsApp startup error:", error);

    connectionStatus = "error";

    if (!reconnecting) {
      reconnecting = true;

      setTimeout(async () => {
        reconnecting = false;
        await startWhatsApp();
      }, 5000);
    }
  }
}

/*
|--------------------------------------------------------------------------
| Home page
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/*
|--------------------------------------------------------------------------
| Status API
|--------------------------------------------------------------------------
*/

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    connected: connectionStatus === "connected",
    hasQR: Boolean(currentQRImage),
    hasPairingCode: Boolean(pairingCode)
  });
});

/*
|--------------------------------------------------------------------------
| QR API
|--------------------------------------------------------------------------
*/

app.get("/api/qr", (req, res) => {
  if (!currentQRImage) {
    return res.json({
      success: false,
      message: "QR code is not available yet."
    });
  }

  res.json({
    success: true,
    qr: currentQRImage
  });
});

/*
|--------------------------------------------------------------------------
| Pairing code API
|--------------------------------------------------------------------------
*/

app.post("/api/pair", async (req, res) => {
  try {
    let number = String(
      req.body.number || ""
    ).replace(/\D/g, "");

    /*
    |--------------------------------------------------------------------------
    | Example:
    | Kenya:
    | 254712345678
    |
    | Do NOT send:
    | +254712345678
    | 0712345678
    |--------------------------------------------------------------------------
    */

    if (!number) {
      return res.status(400).json({
        success: false,
        message: "Enter your WhatsApp number with country code."
      });
    }

    if (number.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number."
      });
    }

    if (!sock) {
      return res.status(503).json({
        success: false,
        message: "WhatsApp connection is starting. Try again."
      });
    }

    if (sock.authState?.creds?.registered) {
      return res.status(400).json({
        success: false,
        message: "This ADEZ-MD session is already paired."
      });
    }

    lastPhoneNumber = number;

    connectionStatus = "pairing";

    pairingCode =
      await sock.requestPairingCode(number);

    /*
    |--------------------------------------------------------------------------
    | Format code for display
    |--------------------------------------------------------------------------
    */

    pairingCode =
      pairingCode?.match(/.{1,4}/g)?.join("-") ||
      pairingCode;

    res.json({
      success: true,
      code: pairingCode,
      message: "Pairing code generated."
    });

  } catch (error) {
    console.error("Pairing error:", error);

    res.status(500).json({
      success: false,
      message: "Could not generate pairing code."
    });
  }
});

/*
|--------------------------------------------------------------------------
| Reset displayed pairing data
|--------------------------------------------------------------------------
*/

app.post("/api/reset", (req, res) => {
  currentQR = null;
  currentQRImage = null;
  pairingCode = null;

  res.json({
    success: true
  });
});

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
  console.log("");
  console.log("=================================");
  console.log("        ADEZ-MD PAIRING");
  console.log("=================================");
  console.log(`Server running on port ${PORT}`);
  console.log("=================================");
  console.log("");

  startWhatsApp();
});
