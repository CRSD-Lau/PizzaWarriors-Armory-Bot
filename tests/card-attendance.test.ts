import assert from "node:assert/strict";
import test from "node:test";
import { perfectSignupMembers } from "../src/card.js";
import type { CoreAttendanceHistory, CoreAttendanceMemberHistory } from "../src/core-attendance.js";
import type { CoreRosterStatus } from "../src/core-roster.js";

function member(displayName: string, statuses: Array<CoreRosterStatus | undefined>): CoreAttendanceMemberHistory {
  return {
    discordUserId: String(10 ** 15 + displayName.length).padEnd(16, "0"),
    displayName,
    statuses,
    trackedCount: statuses.filter((status) => status !== undefined).length,
    missingCount: statuses.filter((status) => status === "Missing").length,
    absentCount: statuses.filter((status) => status === "Absent").length,
    tentativeCount: statuses.filter((status) => status === "Tentative").length,
    benchCount: statuses.filter((status) => status === "Bench").length,
  };
}

function history(eventCount: number, members: CoreAttendanceMemberHistory[]): Pick<CoreAttendanceHistory, "events" | "members"> {
  return {
    events: Array.from({ length: eventCount }, (_, index) => ({
      eventId: String(10 ** 15 + index).padEnd(16, "0"),
      title: `Raid ${index + 1}`,
      startsAt: index,
      capturedAt: index,
      rosterUpdatedAt: index,
      entries: [],
    })),
    members,
  };
}

test("perfect signup recognition requires Signed for every selected event and sorts names", () => {
  const candidates = [
    member("Zulu", ["Signed", "Signed"]),
    member("Absent responder", ["Signed", "Absent"]),
    member("Late responder", ["Signed", "Late"]),
    member("Tentative responder", ["Signed", "Tentative"]),
    member("Bench responder", ["Signed", "Bench"]),
    member("Missing responder", ["Signed", "Missing"]),
    member("Untracked member", [undefined, "Signed"]),
    member("Partial history", ["Signed"]),
    member("Alpha & <Core>", ["Signed", "Signed"]),
  ];

  assert.deepEqual(
    perfectSignupMembers(history(2, candidates)).map((candidate) => candidate.displayName),
    ["Alpha & <Core>", "Zulu"],
  );
});

test("perfect signup recognition stays empty for an empty history window", () => {
  assert.deepEqual(perfectSignupMembers(history(0, [member("No vacuous winner", [])])), []);
});
