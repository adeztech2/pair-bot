"index.js"

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
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const SESSION_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const logger = P({
  level: "silent"
});

/*
|--------------------------------------------------------------------------
| Device storage
|--------------------------------------------------------------------------
*/

const devices = new Map();

/*
|--------------------------------------------------------------------------
| Generate device ID
|--------------------------------------------------------------------------
*/

function createDeviceId() {
  return crypto.randomBytes(6).toString("hex");
}

/*
|--------------------------------------------------------------------------
| Get device session path
|--------------------------------------------------------------------------
*/

function getSessionPath(deviceId) {
  return path.join(SESSION_DIR, deviceId);
}

/*
|--------------------------------------------------------------------------
| Start a WhatsApp device
|--------------------------------------------------------------------------
*/

async function startDevice(deviceId) {

  const sessionPath =
    getSessionPath(deviceId);

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, {
      recursive: true
    });
  }

  let device =
    devices.get(deviceId);

  if (!device) {

    device = {
      id: deviceId,
      socket: null,
      qr: null,
      qrImage: null,
      pairingCode: null,
      status: "starting",
      phone: null,
      createdAt: Date.now(),
      reconnecting: false
    };

    devices.set(deviceId, device);
  }

  try {

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({

      auth: state,

      browser:
        Browsers.ubuntu("ADEZ-MD"),

      logger,

      markOnlineOnConnect: false,

      printQRInTerminal: false
    });

    device.socket = sock;
    device.status = "connecting";

    /*
    |--------------------------------------------------------------------------
    | Save authentication credentials
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
      "creds.update",
      saveCreds
    );

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
        | QR generated
        */

        if (qr) {

          try {

            device.qr = qr;

            device.qrImage =
              await QRCode.toDataURL(
                qr,
                {
                  width: 350,
                  margin: 2
                }
              );

            device.status =
              "waiting_for_qr";

            console.log(
              `[${deviceId}] QR generated`
            );

          } catch (error) {

            console.error(
              `[${deviceId}] QR error`,
              error
            );

          }
        }

        /*
        | Connected
        */

        if (connection === "open") {

          device.status =
            "connected";

          device.qr = null;
          device.qrImage = null;
          device.pairingCode = null;

          if (
            sock.user &&
            sock.user.id
          ) {

            device.phone =
              sock.user.id
                .split(":")[0];

          }

          console.log(
            `[${deviceId}] Connected`
          );
        }

        /*
        | Connecting
        */

        if (
          connection === "connecting"
        ) {

          device.status =
            "connecting";
        }

        /*
        | Disconnected
        */

        if (
          connection === "close"
        ) {

          device.qr = null;
          device.qrImage = null;

          const statusCode =
            new Boom(
              lastDisconnect?.error
            )
              ?.output
              ?.statusCode;

          const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut;

          device.status =
            "disconnected";

          console.log(
            `[${deviceId}] Disconnected`
          );

          /*
          | Automatic reconnection
          */

          if (
            shouldReconnect &&
            !device.reconnecting
          ) {

            device.reconnecting =
              true;

            setTimeout(
              async () => {

                device.reconnecting =
                  false;

                await startDevice(
                  deviceId
                );

              },
              3000
            );
          }
        }
      }
    );

    /*
    |--------------------------------------------------------------------------
    | Example ADEZ-MD bot handler
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        try {

          const message =
            messages?.[0];

          if (!message) return;

          if (message.key.fromMe)
            return;

          if (!message.message)
            return;

          const jid =
            message.key.remoteJid;

          if (!jid) return;

          const text =
            message.message.conversation ||
            message.message.extendedTextMessage?.text ||
            "";

          /*
          | Test command
          */

          if (
            text.toLowerCase() ===
            ".ping"
          ) {

            await sock.sendMessage(
              jid,
              {
                text:
                  "🏓 ADEZ-MD is online!"
              }
            );
          }

        } catch (error) {

          console.error(
            `[${deviceId}] Message error`,
            error
          );

        }
      }
    );

  } catch (error) {

    console.error(
      `[${deviceId}] Startup error`,
      error
    );

    device.status = "error";

    if (!device.reconnecting) {

      device.reconnecting =
        true;

      setTimeout(
        async () => {

          device.reconnecting =
            false;

          await startDevice(
            deviceId
          );

        },
        5000
      );
    }
  }
}

/*
|--------------------------------------------------------------------------
| Create new device
|--------------------------------------------------------------------------
*/

app.post(
  "/api/device/create",
  async (req, res) => {

    try {

      const deviceId =
        createDeviceId();

      await startDevice(
        deviceId
      );

      res.json({

        success: true,

        deviceId,

        message:
          "New ADEZ-MD device created."

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          "Could not create device."

      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Device information
|--------------------------------------------------------------------------
*/

app.get(
  "/api/device/:id",
  (req, res) => {

    const device =
      devices.get(
        req.params.id
      );

    if (!device) {

      return res.status(404).json({

        success: false,

        message:
          "Device not found."

      });
    }

    res.json({

      success: true,

      device: {

        id: device.id,

        status: device.status,

        phone: device.phone,

        hasQR:
          Boolean(device.qrImage),

        hasPairingCode:
          Boolean(
            device.pairingCode
          )

      }

    });
  }
);

/*
|--------------------------------------------------------------------------
| QR code
|--------------------------------------------------------------------------
*/

app.get(
  "/api/device/:id/qr",
  (req, res) => {

    const device =
      devices.get(
        req.params.id
      );

    if (!device) {

      return res.status(404).json({

        success: false,

        message:
          "Device not found."

      });
    }

    if (!device.qrImage) {

      return res.json({

        success: false,

        message:
          "QR code is not available yet."

      });
    }

    res.json({

      success: true,

      qr:
        device.qrImage

    });
  }
);

/*
|--------------------------------------------------------------------------
| Pairing code
|--------------------------------------------------------------------------
*/

app.post(
  "/api/device/:id/pair",
  async (req, res) => {

    try {

      const device =
        devices.get(
          req.params.id
        );

      if (!device) {

        return res.status(404).json({

          success: false,

          message:
            "Device not found."

        });
      }

      if (!device.socket) {

        return res.status(503).json({

          success: false,

          message:
            "WhatsApp socket is not ready."

        });
      }

      let number =
        String(
          req.body.number || ""
        ).replace(/\D/g, "");

      if (!number) {

        return res.status(400).json({

          success: false,

          message:
            "Enter your phone number with country code."

        });
      }

      if (number.length < 8) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid phone number."

        });
      }

      /*
      | Do not request another pairing
      | after the account is registered.
      */

      if (
        device.socket.authState
          ?.creds?.registered
      ) {

        return res.status(400).json({

          success: false,

          message:
            "This device is already paired."

        });
      }

      device.phone =
        number;

      device.status =
        "pairing";

      /*
      | Baileys expects the number
      | in international format.
      */

      const code =
        await device.socket
          .requestPairingCode(
            number
          );

      device.pairingCode =
        code;

      res.json({

        success: true,

        deviceId:
          device.id,

        code,

        message:
          "Pairing code generated."

      });

    } catch (error) {

      console.error(
        "Pairing error:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          "Unable to generate pairing code."

      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Logout one device
|--------------------------------------------------------------------------
*/

app.post(
  "/api/device/:id/logout",
  async (req, res) => {

    const device =
      devices.get(
        req.params.id
      );

    if (!device) {

      return res.status(404).json({

        success: false,

        message:
          "Device not found."

      });
    }

    try {

      if (device.socket) {

        await device.socket.logout();

      }

    } catch (error) {

      console.error(
        "Logout error:",
        error
      );
    }

    devices.delete(
      req.params.id
    );

    const sessionPath =
      getSessionPath(
        req.params.id
      );

    fs.rmSync(
      sessionPath,
      {
        recursive: true,
        force: true
      }
    );

    res.json({

      success: true,

      message:
        "Device logged out."

    });
  }
);

/*
|--------------------------------------------------------------------------
| List active devices
|--------------------------------------------------------------------------
*/

app.get(
  "/api/devices",
  (req, res) => {

    const list =
      [...devices.values()]
        .map(device => ({

          id:
            device.id,

          status:
            device.status,

          phone:
            device.phone,

          hasQR:
            Boolean(
              device.qrImage
            ),

          hasPairingCode:
            Boolean(
              device.pairingCode
            )

        }));

    res.json({

      success: true,

      devices: list

    });
  }
);

/*
|--------------------------------------------------------------------------
| Home
|--------------------------------------------------------------------------
*/

app.get(
  "*",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );

  }
);

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  () => {

    console.log("");
    console.log(
      "===================================="
    );
    console.log(
      "          ADEZ-MD MULTI DEVICE"
    );
    console.log(
      "===================================="
    );
    console.log(
      `Server running on port ${PORT}`
    );
    console.log(
      "===================================="
    );
    console.log("");

  }
);
