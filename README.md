# @keumbang/openapi-mcp

[![npm](https://img.shields.io/npm/v/@keumbang/openapi-mcp)](https://www.npmjs.com/package/@keumbang/openapi-mcp)
[![CI](https://github.com/keumbang/keumbang-openapi-mcp/actions/workflows/publish.yml/badge.svg)](https://github.com/keumbang/keumbang-openapi-mcp/actions/workflows/publish.yml)
[![node](https://img.shields.io/node/v/@keumbang/openapi-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@keumbang/openapi-mcp)](./LICENSE)

금방(Keumbang) Open API **코딩 어시스턴트 MCP 서버**. Claude Desktop · Cursor · Cline 등 MCP 클라이언트에 붙여, 금·은 거래 API 연동 코드를 정확히 짜도록 돕는다.

## API 키 발급

Open API 키(`gpk_` 액세스 키 + `sk_` 시크릿 키)는 **골드팝콘 앱에서만 발급**된다. 웹 발급 경로는 없다.

1. 골드팝콘 앱 설치 — [App Store](https://apps.apple.com/kr/app/id6747214612) · [Google Play](https://play.google.com/store/apps/details?id=com.keumbang.goldpopcorn)
2. 회원가입 후 앱 내 Open API 메뉴에서 키 발급
3. `sk_` 시크릿 키는 **발급 화면에서만 노출**된다 — 그 자리에서 안전한 곳에 보관

이 API에서 개발자가 막히는 지점은 필드명이 아니라 **요청 서명**이다 — `query_hash` 입력이 메서드에 따라 갈리고(POST=raw body, GET=정규화 querystring) 업비트 예제를 그대로 옮기면 전부 401이 난다. 이 MCP는 그 절차를 코드로 생성하고 로컬에서 서명/검증까지 해준다.

## 도구

| 도구 | 용도 |
|---|---|
| `list_endpoints` | 엔드포인트 목록 — 권한 스코프·멱등성·rate 버킷 포함 |
| `get_endpoint` | 단일 엔드포인트 상세 — 파라미터·본문 스키마·요청/성공 응답 예제·응답 코드 |
| `list_error_codes` | 에러 코드 표 + 상태 코드별 재시도 판단 + 함정(잔액 부족=400 P0001, 인증 실패=401 error:null) |
| `signing_guide` | JWT 서명 절차 — `query_hash` 분기·시각 클레임·nonce·멱등성 |
| `generate_signed_request` | 언어별(python/javascript/go/curl) 완결형 서명 요청 코드 생성 |
| `sign_request` | 실제 키로 JWT를 **로컬 계산**(디버깅) — JWT·query_hash·바로 쓸 curl 반환 |
| `verify_signature` | 이미 만든 JWT를 서버와 같은 순서로 검증 — 401 원인 진단 |
| `call_api` *(opt-in)* | 실제 호출 — **조회 전용·production 고정**. env 로 켤 때만 등록 |

리소스: `keumbang://openapi.yaml`(전체 스펙), `keumbang://overview`(서명·한도·에러 산문).

> **보안**: `sign_request`/`verify_signature`/`call_api`에 넘긴 `secret_key`는 로컬 서명에만 쓰이고 서명 결과(JWT)만 전송된다 — secret 자체는 네트워크를 타지 않는다.

### call_api — 조회 전용 라이브 호출

기본 **비활성**. `KEUMBANG_MCP_ALLOW_LIVE=true` 일 때만 등록된다. 4중 안전장치로 자금 이동을 원천 차단:

1. **env 게이트** — 변수 없으면 도구 자체가 없다
2. **화이트리스트** — `getPrices` / `getBalances` / `getPriceHistory` / `getOrderPreview` 만. `buy`·`sell`·`payout`·`virtual-accounts` 는 라이브 불가(코드 생성만)
3. **production 고정** — 인자로 서버를 바꿀 수 없다. 조회 전용이라 production 을 읽어도 자금은 움직이지 않는다
4. **GET 강제** — 쓰기 메서드 차단

자금 이동 엔드포인트를 실제로 호출하려면 `generate_signed_request` 로 코드를 받아 개발자 본인 환경에서 실행한다.

## 설치 · 빌드

```bash
git clone https://github.com/keumbang/keumbang-openapi-mcp.git
cd keumbang-openapi-mcp
npm install
npm run build       # dist/ 생성
npm test            # 서명 회귀 테스트
```

## MCP 클라이언트 등록

배포 후(npm publish 시) — 권장:

```json
{ "mcpServers": { "keumbang-openapi": { "command": "npx", "args": ["-y", "@keumbang/openapi-mcp"] } } }
```

로컬 클론 실행:

```json
{
  "mcpServers": {
    "keumbang-openapi": {
      "command": "node",
      "args": ["/절대경로/keumbang-openapi-mcp/dist/index.js"]
    }
  }
}
```

Claude Desktop `claude_desktop_config.json`, Cursor `~/.cursor/mcp.json`. 개발 중엔 `command: "npx", args: ["tsx", "/절대경로/.../src/index.ts"]`.

## 환경변수

| 변수 | 기본 | 의미 |
|---|---|---|
| `KEUMBANG_OPENAPI_SPEC` | 번들 `spec/openapi.yaml` | 스펙 파일 경로 재지정 |
| `KEUMBANG_MCP_ALLOW_LIVE` | (없음) | `true` 면 `call_api`(조회 전용·production) 활성화 |

## 예시 대화

- "sellAsset 을 파이썬으로 호출하는 코드 줘, 금 0.5g" → `generate_signed_request(operationId=sellAsset, language=python, pathParams={asset:gold}, body={quantity:0.5})`
- "보유한 금 전부 팔려면?" → `generate_signed_request(operationId=sellAsset, language=python, pathParams={asset:gold}, body={quantity:0.001, sell_all:true})` — `sell_all` 이 요청 수량을 무시하고 가용 잔량 전량을 체결한다
- "이 JWT 가 왜 401 나?" → `verify_signature(token=..., secretKey=..., method=POST, rawBody=...)`
- "가격 이력 엔드포인트 파라미터 뭐야?" → `get_endpoint(operationId=getPriceHistory)`
- "잔액 부족이면 몇 번 에러야?" → `list_error_codes` — `400 P0001`(500 아님). 상태 코드별 재시도 판단표도 같이 나온다

## 스펙 동기화

스펙 원본은 **백엔드 repo 의 `docs/openapi.yaml`**(이 repo 밖)이고, 이 repo 는 `spec/openapi.yaml` 사본을 번들한다. 원본이 바뀌면 `SPEC_SRC` 로 경로를 지정해 갱신한다:

```bash
SPEC_SRC=/path/to/<backend-repo>/docs/openapi.yaml npm run sync-spec
```
(백엔드 repo 를 sibling 으로 클론했으면 `../<backend-repo>/docs/openapi.yaml` 가 기본값이라 인자 없이 `npm run sync-spec`.)

갱신 후 `spec/openapi.yaml` 을 커밋한다. 서명 규칙이 서버와 어긋나면 `npm test`(서버 검증 규칙 미러)가 잡는다.
```
<backend-repo>/docs/openapi.yaml  ──sync-spec──▶  spec/openapi.yaml
```
