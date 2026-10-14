import assert from "node:assert/strict";
import test from "node:test";
import { formatAttendancePercentage, recordedAttendanceTally } from "../src/card.js";
import type { CoreAttendanceHistory, CoreAttendanceMemberHistory } from "../src/core-attendance.js";
import type { CoreRosterStatus } from "../src/core-roster.js";
import { isAttendedStatus, perfectAttendanceMembers, type RaidAttendanceSummary } from "../src/raid-attendance.js";

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

function history(eventCount: number, members: CoreAttendanceMemberHistory[]): CoreAttendanceHistory {
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
    trackedResponses: members.reduce((total, item) => total + item.trackedCount, 0),
    missingSignups: members.reduce((total, item) => total + item.missingCount, 0),
    explicitAbsences: members.reduce((total, item) => total + item.absentCount, 0),
    responseRate: 0,
    reliableMembers: 0,
  };
}

function summary(eventCount: number, members: CoreAttendanceMemberHistory[], unavailableEventIds: string[] = []): RaidAttendanceSummary {
  return {
    history: history(eventCount, members),
    requestedRaids: eventCount,
    unavailableRaids: unavailableEventIds.length,
    unavailableEventIds,
    refreshedAt: 1,
  };
}

test("attendance recognizes Signed and Tentative across the full completed window", () => {
  const candidates = [
    member("Zulu", ["Signed", "Signed"]),
    member("Absent responder", ["Signed", "Absent"]),
    member("Late responder", ["Signed", "Late"]),
    member("Tentative attendee", ["Signed", "Tentative"]),
    member("Bench responder", ["Signed", "Bench"]),
    member("Missing responder", ["Signed", "Missing"]),
    member("Untracked member", [undefined, "Signed"]),
    member("Partial history", ["Signed"]),
    member("Alpha & <Core>", ["Signed", "Signed"]),
  ];

  assert.deepEqual(
    perfectAttendanceMembers(summary(2, candidates)).map((candidate) => candidate.displayName).sort(),
    ["Alpha & <Core>", "Tentative attendee", "Zulu"],
  );
  assert.equal(isAttendedStatus("Tentative"), true);
  assert.equal(isAttendedStatus("Late"), false);
  assert.equal(isAttendedStatus("Bench"), false);
});

test("attendance recognition rejects empty and incomplete windows", () => {
  assert.deepEqual(perfectAttendanceMembers(summary(0, [member("No vacuous winner", [])])), []);
  const incomplete = summary(1, [member("Unavailable miss", ["Missing"])], ["1000000000000000"]);
  assert.deepEqual(perfectAttendanceMembers(incomplete), [], "a saved-only Missing status must still block recognition");
});

test("row attendance uses each member's tracked history as its denominator", () => {
  assert.deepEqual(recordedAttendanceTally(member("Joined later", [undefined, "Tentative", "Late"])), {
    attended: 1,
    recorded: 2,
  });
});

test("aggregate attendance never rounds an imperfect record up to 100%", () => {
  assert.equal(formatAttendancePercentage(287, 288), "99.6%");
  assert.equal(formatAttendancePercentage(288, 288), "100%");
});
