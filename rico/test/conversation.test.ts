import { expect, test } from "bun:test";
import {
  sanitizeConversationReplyForSlack,
  shapeCaptainConversationReplyForSlack,
} from "../src/codex/conversation";

test("sanitizeConversationReplyForSlack normalizes autolinks and stiff session phrasing", () => {
  const sanitized = sanitizeConversationReplyForSlack(
    "캡틴: 이 세션에서 origin이 https://github.com/xogjs/Crypto.git로 잡혀 있고 `main`도 `origin/main`을 추적합니다.",
  );

  expect(sanitized).toContain("지금 확인 기준으로는");
  expect(sanitized).toContain("`https://github.com/xogjs/Crypto.git`로");
  expect(sanitized.includes("<https://")).toBe(false);
  expect(sanitized.includes("로>")).toBe(false);
});

test("shapeCaptainConversationReplyForSlack formats repo status replies into a compact factual summary", () => {
  const shaped = shapeCaptainConversationReplyForSlack({
    message: "지금 원격 깃이 연결되어있나?",
    reply:
      "캡틴: 원격 설정 자체는 연결돼 있어요. /home/tony/srv/crypto 가 실제 Git 저장소이고 origin이 https://github.com/xogjs/Crypto.git 로 잡혀 있고 main도 origin/main 을 추적합니다. 다만 git ls-remote 는 인증 없이 실패해서 실제 원격 접근은 아직 못 봤어요.",
  });

  expect(shaped).toBe(
    "캡틴:\n- 결론: 원격 설정은 연결돼 있어요. 다만 실제 원격 접근은 아직 미확인이에요.\n- 확인됨: workspace `/home/tony/srv/crypto`, origin `https://github.com/xogjs/Crypto.git`, 브랜치 `main -> origin/main`\n- 미확인: GitHub 인증이 없어 `git ls-remote` 기준 실제 원격 접근까지는 아직 못 봤어요.\n- 다음 단계: 인증이 붙은 환경에서 `git ls-remote --heads origin` 또는 `git fetch origin` 한 번만 더 보면 끝나요.",
  );
});

test("shapeCaptainConversationReplyForSlack turns repo follow-up prompts into direct next steps", () => {
  const shaped = shapeCaptainConversationReplyForSlack({
    message: "남은 조치 해봐",
    reply: "캡틴: origin은 https://github.com/xogjs/Crypto.git 이고 main은 origin/main 을 추적합니다. 다만 git ls-remote 는 인증 없이 실패했습니다.",
    threadHistory: [
      { speaker: "user", text: "지금 원격 깃이 연결되어있나?" },
      { speaker: "assistant", text: "캡틴: 원격 설정은 연결돼 있어요." },
    ],
  });

  expect(shaped).toBe(
    "캡틴:\n- 지금 확인된 것: origin `https://github.com/xogjs/Crypto.git`, 브랜치 `main -> origin/main`예요.\n- 아직 못 본 것: GitHub 인증이 없어 실제 원격 fetch/ls-remote 성공 여부는 확인 못 했어요.\n- 바로 할 다음 단계: 인증이 붙은 환경에서 `git ls-remote --heads origin`이나 `git fetch origin` 한 번만 더 보면 끝나요.",
  );
});
