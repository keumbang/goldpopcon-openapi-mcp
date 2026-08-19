// 금방 Open API 스펙 원본 → 이 repo 의 번들 사본(spec/openapi.yaml) 동기화.
//
// 스펙 원본은 백엔드 repo 의 docs/openapi.yaml 에 있다(이 repo 밖).
// 경로는 SPEC_SRC 환경변수로 지정한다. 없으면 sibling 위치를 기본으로 시도한다.
//   SPEC_SRC=/path/to/<backend-repo>/docs/openapi.yaml npm run sync-spec
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = process.env.SPEC_SRC ?? resolve(here, "../../<backend-repo>/docs/openapi.yaml");
const dst = resolve(here, "../spec/openapi.yaml");

if (!existsSync(src)) {
  console.error(`스펙 원본 없음: ${src}`);
  console.error(`SPEC_SRC 환경변수로 <backend-repo>/docs/openapi.yaml 경로를 지정하라.`);
  process.exit(1);
}
copyFileSync(src, dst);
console.log(`synced: ${src} -> ${dst}`);

// docs/ 사이트는 스펙에서 생성된다 — 스펙만 갱신하고 문서를 잊으면 즉시 어긋난다.
// dist 가 없으면(클론 직후) 건너뛴다.
if (existsSync(resolve(here, "../dist/spec.js"))) {
  await import("./gen-docs.mjs");
} else {
  console.log("dist 없음 — docs/ 갱신은 `npm run docs`");
}
