import type { Agent, Council, Room } from "./types.js";

// Shared by the room and the saved record, so both tell the same story.

export const listNames = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

// Where did each member put its own answer? Both ends of the ballot are telling.
export function selfPlacementNote(council: Council, nameOf: (agentId: string) => string) {
  const { labels = {}, ballots = {} } = council.results;
  const places = Object.entries(ballots).map(([ranker, ballot]) => ({ ranker, place: ballot.indexOf(Object.entries(labels).find(([, id]) => id === ranker)?.[0] ?? ""), size: ballot.length }));
  const first = places.filter((entry) => entry.place === 0).map((entry) => nameOf(entry.ranker));
  const last = places.filter((entry) => entry.size > 1 && entry.place === entry.size - 1).map((entry) => nameOf(entry.ranker));
  return [
    first.length ? `${listNames(first)} ranked ${first.length === 1 ? "its own answer" : "their own answers"} first.` : "No one ranked their own answer first.",
    last.length ? `${listNames(last)} ranked ${last.length === 1 ? "its own" : "their own"} last.` : "",
  ].filter(Boolean).join(" ");
}

// How the chair stood in the blind ranking. A tie at the top is said as one.
export function chairStanding(council: Pick<Council, "results">, chairId: string) {
  const { order = [], points = {}, firstPlaceVotes = {} } = council.results;
  if (order[0] !== chairId) return null;
  const tied = order.length > 1 && points[order[1]] === points[chairId] && (firstPlaceVotes[order[1]]?.length ?? 0) === (firstPlaceVotes[chairId]?.length ?? 0);
  return tied ? "tied for first in the blind round" : "ranked first in the blind round";
}

// The project a council belongs to: the room's folder, or else the one folder every member works in.
export function councilProjectDir(room: Pick<Room, "projectCwd">, agents: Array<Pick<Agent, "id" | "cwd">>, council: Pick<Council, "agentIds">) {
  if (room.projectCwd) return room.projectCwd;
  const folders = new Set(council.agentIds.map((id) => agents.find((agent) => agent.id === id)?.cwd ?? null));
  const [only] = folders;
  return folders.size === 1 && only ? only : null;
}
