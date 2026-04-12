import { expect, test } from "bun:test";
import { selectSpecialistRoles } from "../src/orchestrator/role-selection";

test("goal ideation uses planner and customer voice without QA by default", () => {
  expect(selectSpecialistRoles("이 채널 목표 제안해봐")).toEqual([
    "planner",
    "customer-voice",
  ]);
});

test("repo connectivity questions route to backend instead of QA", () => {
  expect(selectSpecialistRoles("지금 원격 깃이 연결되어있나?")).toEqual([
    "backend",
  ]);
});

test("deployment work pulls in backend and QA with customer voice", () => {
  expect(selectSpecialistRoles("온보딩 개선하고 배포까지 준비해")).toEqual([
    "planner",
    "designer",
    "frontend",
    "backend",
    "qa",
    "customer-voice",
  ]);
});
