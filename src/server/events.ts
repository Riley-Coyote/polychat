import type { Response } from "express";
import type { RoomEvent, RoomEventPayload } from "../shared/types.js";

type Client = { roomId: string; response: Response };
const clients = new Set<Client>();
let cursor = Date.now();
const recent: RoomEvent[] = [];

export function currentCursor() { return cursor; }

export function subscribe(roomId: string, response: Response, after = 0) {
  const client = { roomId, response };
  clients.add(client);
  for (const event of recent.filter((item) => item.roomId === roomId && item.eventId > after)) write(response, event);
  response.write(`event: ready\nid: ${cursor}\ndata: ${JSON.stringify({ eventCursor: cursor })}\n\n`);
  response.on("close", () => clients.delete(client));
}

function write(response: Response, event: RoomEvent) {
  response.write(`event: room\nid: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function publish(roomId: string, payload: RoomEventPayload): RoomEvent {
  const event = { ...payload, roomId, eventId: ++cursor } as RoomEvent;
  recent.push(event);
  if (recent.length > 500) recent.splice(0, recent.length - 500);
  for (const client of clients) if (client.roomId === roomId) write(client.response, event);
  return event;
}
