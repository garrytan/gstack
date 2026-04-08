/**
 * src/__tests__/components.WorkCard.test.tsx
 * components/WorkCard.tsx — compact 모드 포함 렌더링 테스트
 *
 * 우선순위 5 (컴포넌트)
 *   - 기본 렌더링: 이름, 상태, 파이프라인 수, 상대 시간
 *   - compact=true (기본값): 소형 카드 크기
 *   - compact=false: 대형 카드 크기
 *   - task_summary 있을 때 progress bar 표시
 *   - onClick 호출
 *   - 키보드 접근성 (Enter, Space)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkCard } from "@/components/WorkCard";
import type { WorkUnit } from "@/lib/types";

// ─────────────────────────────────────────────────────────────
// 테스트 데이터
// ─────────────────────────────────────────────────────────────

const baseWorkUnit: WorkUnit = {
  id: 1,
  slug: "test-wu",
  name: "테스트 워크유닛",
  status: "active",
  created_at: new Date(Date.now() - 60_000).toISOString(), // 1분 전
  updated_at: new Date().toISOString(),
};

const workUnitWithTasks = {
  ...baseWorkUnit,
  pipelineCount: 3,
  task_summary: {
    total: 10,
    done: 7,
    in_progress: 2,
    backlog: 1,
  },
};

// ─────────────────────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────────────────────

describe("WorkCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("기본 렌더링", () => {
    it("워크유닛 이름 표시", () => {
      render(<WorkCard workunit={baseWorkUnit} onClick={vi.fn()} />);
      expect(screen.getByText("테스트 워크유닛")).toBeInTheDocument();
    });

    it("status 뱃지 표시", () => {
      render(<WorkCard workunit={baseWorkUnit} onClick={vi.fn()} />);
      // StatusBadge가 status 텍스트를 렌더링
      expect(screen.getByText("active")).toBeInTheDocument();
    });

    it("pipelineCount 없을 때 → '0 pipelines' 표시", () => {
      render(<WorkCard workunit={baseWorkUnit} onClick={vi.fn()} />);
      expect(screen.getByText("0 pipelines")).toBeInTheDocument();
    });

    it("pipelineCount=1 → '1 pipeline' (단수)", () => {
      render(
        <WorkCard
          workunit={{ ...baseWorkUnit, pipelineCount: 1 }}
          onClick={vi.fn()}
        />
      );
      expect(screen.getByText("1 pipeline")).toBeInTheDocument();
    });

    it("pipelineCount=3 → '3 pipelines' (복수)", () => {
      render(
        <WorkCard
          workunit={{ ...baseWorkUnit, pipelineCount: 3 }}
          onClick={vi.fn()}
        />
      );
      expect(screen.getByText("3 pipelines")).toBeInTheDocument();
    });

    it("상대 시간 표시 (1m ago)", () => {
      render(<WorkCard workunit={baseWorkUnit} onClick={vi.fn()} />);
      expect(screen.getByText("1m ago")).toBeInTheDocument();
    });
  });

  describe("compact 모드", () => {
    it("compact=true (기본값) → 폰트 12px", () => {
      const { container } = render(
        <WorkCard workunit={baseWorkUnit} onClick={vi.fn()} />
      );
      // 이름 span의 fontSize 확인
      const nameSpan = container.querySelector(
        "span[style*='font-weight: 600']"
      ) as HTMLSpanElement | null;
      expect(nameSpan?.style.fontSize).toBe("12px");
    });

    it("compact=false → 폰트 13px", () => {
      const { container } = render(
        <WorkCard workunit={baseWorkUnit} onClick={vi.fn()} compact={false} />
      );
      const nameSpan = container.querySelector(
        "span[style*='font-weight: 600']"
      ) as HTMLSpanElement | null;
      expect(nameSpan?.style.fontSize).toBe("13px");
    });

    it("compact=true → StatusBadge size=xs", () => {
      const { container } = render(
        <WorkCard workunit={baseWorkUnit} onClick={vi.fn()} compact={true} />
      );
      // xs size → 폰트 9px
      const badge = container.querySelector(
        "span[style*='9px']"
      );
      expect(badge).toBeTruthy();
    });
  });

  describe("task_summary — progress bar", () => {
    it("task_summary 있을 때 progress bar 렌더링", () => {
      const { container } = render(
        <WorkCard workunit={workUnitWithTasks} onClick={vi.fn()} />
      );
      // "Tasks" 텍스트 확인
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });

    it("done/total 비율 표시 (7/10, 70%)", () => {
      render(<WorkCard workunit={workUnitWithTasks} onClick={vi.fn()} />);
      expect(screen.getByText("7/10 (70%)")).toBeInTheDocument();
    });

    it("task_summary 없을 때 progress bar 미표시", () => {
      render(<WorkCard workunit={baseWorkUnit} onClick={vi.fn()} />);
      expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    });

    it("total=0이면 progress bar 미표시 (0으로 나누기 방지)", () => {
      render(
        <WorkCard
          workunit={{
            ...baseWorkUnit,
            task_summary: { total: 0, done: 0, in_progress: 0, backlog: 0 },
          }}
          onClick={vi.fn()}
        />
      );
      expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    });

    it("완료율 100% → progress bar width 100%", () => {
      const { container } = render(
        <WorkCard
          workunit={{
            ...baseWorkUnit,
            task_summary: { total: 5, done: 5, in_progress: 0, backlog: 0 },
          }}
          onClick={vi.fn()}
        />
      );
      // 100% 채워진 progress bar div
      const progressFill = Array.from(
        container.querySelectorAll("div")
      ).find((el) => el.style.width === "100%");
      expect(progressFill).toBeTruthy();
    });
  });

  describe("onClick 및 접근성", () => {
    it("클릭 시 onClick 호출", () => {
      const onClick = vi.fn();
      render(<WorkCard workunit={baseWorkUnit} onClick={onClick} />);
      const card = screen.getByRole("button");
      fireEvent.click(card);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("Enter 키 → onClick 호출", () => {
      const onClick = vi.fn();
      render(<WorkCard workunit={baseWorkUnit} onClick={onClick} />);
      const card = screen.getByRole("button");
      fireEvent.keyDown(card, { key: "Enter" });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("Space 키 → onClick 호출", () => {
      const onClick = vi.fn();
      render(<WorkCard workunit={baseWorkUnit} onClick={onClick} />);
      const card = screen.getByRole("button");
      fireEvent.keyDown(card, { key: " " });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("Tab 키 → onClick 호출 안 함", () => {
      const onClick = vi.fn();
      render(<WorkCard workunit={baseWorkUnit} onClick={onClick} />);
      const card = screen.getByRole("button");
      fireEvent.keyDown(card, { key: "Tab" });
      expect(onClick).not.toHaveBeenCalled();
    });

    it("tabIndex=0 (키보드 포커스 가능)", () => {
      render(<WorkCard workunit={baseWorkUnit} onClick={vi.fn()} />);
      const card = screen.getByRole("button");
      expect(card).toHaveAttribute("tabindex", "0");
    });
  });
});
