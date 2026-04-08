/**
 * src/__tests__/components.StatusBadge.test.tsx
 * components/StatusBadge.tsx — 렌더링 테스트
 *
 * 우선순위 5 (컴포넌트)
 *   - status 문자열 표시
 *   - 크기별(xs/sm/md) 폰트 크기 적용
 *   - 알 수 없는 status → fallback 색상
 *   - 대소문자 무관 처리
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/StatusBadge";

describe("StatusBadge", () => {
  describe("status 텍스트 렌더링", () => {
    it("status 문자열이 화면에 표시됨", () => {
      render(<StatusBadge status="running" />);
      expect(screen.getByText("running")).toBeInTheDocument();
    });

    it("completed 표시", () => {
      render(<StatusBadge status="completed" />);
      expect(screen.getByText("completed")).toBeInTheDocument();
    });

    it("failed 표시", () => {
      render(<StatusBadge status="failed" />);
      expect(screen.getByText("failed")).toBeInTheDocument();
    });

    it("알 수 없는 status도 표시됨 (fallback 색상)", () => {
      render(<StatusBadge status="unknown_status" />);
      expect(screen.getByText("unknown_status")).toBeInTheDocument();
    });
  });

  describe("색상 매핑", () => {
    it("running → 파란색 계열 (#3b82f6)", () => {
      const { container } = render(<StatusBadge status="running" />);
      const span = container.querySelector("span");
      expect(span?.style.color).toBe("rgb(59, 130, 246)"); // #3b82f6
    });

    it("completed → 초록색 계열 (#22c55e)", () => {
      const { container } = render(<StatusBadge status="completed" />);
      const span = container.querySelector("span");
      expect(span?.style.color).toBe("rgb(34, 197, 94)"); // #22c55e
    });

    it("failed → 빨간색 계열 (#ef4444)", () => {
      const { container } = render(<StatusBadge status="failed" />);
      const span = container.querySelector("span");
      expect(span?.style.color).toBe("rgb(239, 68, 68)"); // #ef4444
    });

    it("paused → 노란색 계열 (#eab308)", () => {
      const { container } = render(<StatusBadge status="paused" />);
      const span = container.querySelector("span");
      expect(span?.style.color).toBe("rgb(234, 179, 8)"); // #eab308
    });

    it("알 수 없는 status → fallback 색상 (#585870)", () => {
      const { container } = render(<StatusBadge status="custom_unknown" />);
      const span = container.querySelector("span");
      expect(span?.style.color).toBe("rgb(88, 88, 112)"); // #585870
    });

    it("대문자 status → 소문자 변환 후 COLOR_MAP 조회", () => {
      const { container } = render(<StatusBadge status="RUNNING" />);
      const span = container.querySelector("span");
      // RUNNING.toLowerCase() = running → #3b82f6
      expect(span?.style.color).toBe("rgb(59, 130, 246)");
    });
  });

  describe("size prop", () => {
    it("size=xs → 폰트 9px", () => {
      const { container } = render(<StatusBadge status="running" size="xs" />);
      const span = container.querySelector("span");
      expect(span?.style.fontSize).toBe("9px");
    });

    it("size=sm (기본값) → 폰트 10px", () => {
      const { container } = render(<StatusBadge status="running" />);
      const span = container.querySelector("span");
      expect(span?.style.fontSize).toBe("10px");
    });

    it("size=md → 폰트 11px", () => {
      const { container } = render(<StatusBadge status="running" size="md" />);
      const span = container.querySelector("span");
      expect(span?.style.fontSize).toBe("11px");
    });
  });

  describe("dot indicator 렌더링", () => {
    it("dot span이 렌더링됨 (borderRadius: 50%)", () => {
      const { container } = render(<StatusBadge status="running" />);
      const spans = container.querySelectorAll("span");
      // 외부 span + 내부 dot span
      expect(spans.length).toBeGreaterThanOrEqual(2);
      const dotSpan = spans[1];
      expect(dotSpan?.style.borderRadius).toBe("50%");
    });

    it("xs 크기 dot → 4px", () => {
      const { container } = render(<StatusBadge status="running" size="xs" />);
      const dotSpan = container.querySelectorAll("span")[1];
      expect(dotSpan?.style.width).toBe("4px");
      expect(dotSpan?.style.height).toBe("4px");
    });

    it("sm 크기 dot → 5px", () => {
      const { container } = render(<StatusBadge status="running" size="sm" />);
      const dotSpan = container.querySelectorAll("span")[1];
      expect(dotSpan?.style.width).toBe("5px");
    });
  });

  describe("다양한 status 별칭", () => {
    const aliases: Array<[string, string]> = [
      ["active", "rgb(59, 130, 246)"],
      ["in_progress", "rgb(59, 130, 246)"],
      ["done", "rgb(34, 197, 94)"],
      ["success", "rgb(34, 197, 94)"],
      ["error", "rgb(239, 68, 68)"],
      ["abandoned", "rgb(239, 68, 68)"],
      ["cancelled", "rgb(239, 68, 68)"],
      ["warning", "rgb(234, 179, 8)"],
      ["blocked", "rgb(234, 179, 8)"],
      ["backlog", "rgb(88, 88, 112)"],
      ["pending", "rgb(142, 142, 160)"],
    ];

    it.each(aliases)(
      "status=%s → 올바른 색상",
      (status, expectedColor) => {
        const { container } = render(<StatusBadge status={status} />);
        const span = container.querySelector("span");
        expect(span?.style.color).toBe(expectedColor);
      }
    );
  });
});
