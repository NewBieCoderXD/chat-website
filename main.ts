import express, { Request, Response } from "express";
import fs from "fs";
import * as cheerio from "cheerio";
import { createClient, RedisClientType } from "redis";
import moment from "moment";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import expressWs from "express-ws";

const db: RedisClientType = createClient();
const port = 8080;
const wss = expressWs(express());
const app = wss.app;

db.on("error", (err) => console.error("Redis Client Error", err));

interface WebSocketWithUsername extends WebSocket {
  username?: string;
}

type RoomKeyToWS = Map<number, WebSocketWithUsername[]>;

const roomKeyToWS: RoomKeyToWS = new Map();
const Format = "YYYY-MM-DD HH:mm";

function findRoomID(ws: WebSocketWithUsername): number | undefined {
  for (const [key, wsList] of roomKeyToWS) {
    if (wsList.includes(ws)) {
      return key;
    }
  }
  return undefined;
}

function setInputAndAddAlert(
  ID: string,
  name: string,
  msg: string,
  res: Response
): void {
  fs.readFile(__dirname + "/index.html", "utf8", (err, data) => {
    if (err) {
      console.error("Error reading file:", err);
      return;
    }
    const $ = cheerio.load(data);
    $("#ID").attr("value", ID);
    $("#username").attr("value", name);
    $("body").append(msg);
    res.send("html " + $("body").html());
  });
}

// function saveJSON(jsonData: Record<string, any>): void {
//   fs.writeFile("dateAndID.json", JSON.stringify(jsonData), "utf8", (err) => {
//     if (err) {
//       console.error("Error saving JSON:", err);
//     } else {
//       console.log("JSON file has been updated.");
//     }
//   });
// }

// function checkForEmptyList(): boolean {
//   const jsonData = require("./dateAndID.json");
//   return Object.keys(jsonData).length === 0;
// }

function sendChatHTML(
  name: string,
  roomName: string,
  id: string,
  response: Response
): void {
  fs.readFile(__dirname + "/screen3.html", "utf8", (err, data) => {
    if (err) {
      console.error("Error reading file:", err);
      return;
    }
    const $ = cheerio.load(data);
    $("#id").text(id);
    $("#roomName").text(roomName);
    const script = $("script").get(0)?.children[0] as cheerio.Element;
    if (script && script.data) {
      script.data += `
        StartWebSocket(false);
        websocket.onopen = function() {
          AddedLeftMessage = false;
          websocket.send(JSON.stringify({ key: "${id}", name: "${name}" }));
        };
        document.getElementById("Clipboard").addEventListener("click", () => {
          navigator.clipboard.writeText("${id}");
        });
        user = "${name}";
      `;
    }
    response.send("html " + $("body").html());
  });
}

// async function deleteAll(): Promise<void> {
//   const keys = await db.keys("*");
//   for (const key of keys) {
//     await db.del(key);
//     console.log("Deleted:", key);
//   }
// }

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/sw.js", (req, res) => {
  res.attachment("sw.js").type("js").send(" ");
});

app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));
app.get("/sendButton.png", (req, res) => res.sendFile(__dirname + "/send.png"));
app.get("/iconWOW", (req, res) => res.sendFile(__dirname + "/icon.ico"));
app.get("/background.jpg", (req, res) =>
  res.sendFile(__dirname + "/background.jpg")
);
app.get("/style.css", (req, res) => res.sendFile(__dirname + "/style.css"));

app.post("/", function (request, response) {
  if (!request.body.ID || !request.body.username) {
    setInputAndAddAlert(
      request.body.ID,
      request.body.username,
      '<script>alert("ID and username can\'t be emtpy")</script>',
      response
    );
  } else if (request.body.ID.length != 10) {
    setInputAndAddAlert(
      request.body.ID,
      request.body.username,
      '<script>alert("ID\'s invalid")</script>',
      response
    );
  } else {
    db.get(request.body.ID).then((raw) => {
      let roomName: any = raw;
      if (!roomName) {
        setInputAndAddAlert(
          request.body.ID,
          request.body.username,
          '<script>alert("ID\'s invalid")</script>',
          response
        );
      } else {
        let found = roomKeyToWS.get(request.body.ID);
        if (found != undefined) {
          if (found.some((ws) => ws.username == request.body.username)) {
            setInputAndAddAlert(
              request.body.ID,
              request.body.username,
              '<script>alert("Your username has been already taken")</script>',
              response
            );
            return;
          }
        }
        sendChatHTML(
          request.body.username,
          roomName,
          request.body.ID,
          response
        );
      }
    });
  }
});

app.post("/NewRoom", async (req: Request, res: Response) => {
  const { roomName, username } = req.body;
  if (!roomName || !username) {
    res.send("msg Please check your information");
    return;
  }

  const keys = await db.keys("*");
  let id: string;
  do {
    id = Math.random().toString(36).substring(2, 12);
  } while (keys.includes(id));

  await db.set(id, roomName, {
    EX: 10 * 60,
  });
  sendChatHTML(username, roomName, id, res);

  console.log("New room created at", moment().format(Format));
});

app.ws("/", function (ws: WebSocketWithUsername, req) {
  ws.on("connection", (ws: WebSocketWithUsername) => {
    console.log("WebSocket connected");
  });

  ws.on("close", () => {
    const id = findRoomID(ws);
    if (id !== undefined) {
      const list = roomKeyToWS.get(id);
      if (list) {
        list.splice(list.indexOf(ws), 1);
        if (list.length === 0) {
          roomKeyToWS.delete(id);
        }
      }
      console.log(`WebSocket disconnected from room ${id}`);
    }
  });

  ws.on("message", (message: string) => {
    if (!ws.username) {
      const data: { key: number; name: string } = JSON.parse(message);
      if (data.key == undefined) {
        ws.close();
        return;
      }
      console.log(message);
      ws.username = data.name;
      const room = roomKeyToWS.get(data.key) || [];
      room.push(ws);
      roomKeyToWS.set(data.key, room);
      console.log("WebSocket added to room", data.key);
      broadcast(ws, data.name + " has joined", true);
    } else {
      broadcast(ws, message, false);
    }
  });
});

function broadcast(ws: WebSocketWithUsername, data: string, IsMiddle: boolean) {
  data = data
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  wss.getWss().clients.forEach(function each(client: WebSocketWithUsername) {
    if (!IsMiddle) {
      if (client !== ws) {
        client.send(
          JSON.stringify({ position: "left", sender: ws.username, msg: data })
        );
        return;
      }
      client.send(JSON.stringify({ position: "right", msg: data }));
      return;
    }
    client.send(JSON.stringify({ position: "middle", msg: data }));
  });
}

async function start() {
  await db.connect();

  app.listen(port, () => {
    console.log("Server started on port", port);
  });

  // setInterval(async () => {
  //   console.log("Performing cleanup...");
  //   if (!checkForEmptyList()) {
  //     const dateAndID: {
  //       [key: string]: string;
  //     } = require("./dateAndID.json");
  //     const now = moment();
  //     for (const [key, value] of Object.entries(dateAndID)) {
  //       if (moment(key, Format).isBefore(now)) {
  //         await db.del(value);
  //         delete dateAndID[key];
  //         console.log("Deleted expired room:", key);
  //       }
  //     }
  //     saveJSON(dateAndID);
  //   }
  // }, 600000);
}

start();
