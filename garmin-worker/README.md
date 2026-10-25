# STRION Garmin Sync Worker

Garmin Personal API 키를 GitHub Pages에 노출하지 않고 STRION이 최근 러닝 FIT 파일을 가져오게 하는 무료 중계 기능입니다.

## 필요한 값

- `GARMIN_API_KEY`: Garmin Connect Web에서 만든 Personal API 키
- `STRION_ACCESS_CODE`: 본인이 직접 만드는 긴 임의 문자열. Garmin 비밀번호와 다르게 만드세요.
- `ALLOWED_ORIGINS`: STRION 주소. 기본값에는 공개 사이트와 로컬 테스트 주소가 들어 있습니다.

## Cloudflare에서 배포

1. Cloudflare 계정을 만들고 **Workers & Pages → Create → Worker**로 이동합니다.
2. 이 폴더의 `src/worker.js` 전체를 Worker 편집기에 붙여넣고 배포합니다.
3. **Settings → Variables and Secrets**에서 아래 두 값을 `Secret`으로 추가합니다.
   - `GARMIN_API_KEY`
   - `STRION_ACCESS_CODE`
4. 일반 변수 `ALLOWED_ORIGINS`를 공개 사이트만 쓸 때는 `https://zionkoo.github.io`, 로컬 파일에서도 시험할 때는 `https://zionkoo.github.io,null`로 추가합니다.
5. 표시되는 `https://...workers.dev` 주소를 STRION의 Garmin 동기화 창에 입력합니다.
6. 같은 창의 접근 코드에는 `STRION_ACCESS_CODE`에 넣은 값을 입력합니다.

Garmin API 키는 Garmin 비밀번호가 아니며 Personal API Key 페이지에서 별도로 발급합니다. 키는 한 번만 표시되므로 안전한 곳에 보관하세요.

## 로컬 개발 선택 사항

Wrangler를 사용하는 경우:

```sh
npx wrangler secret put GARMIN_API_KEY
npx wrangler secret put STRION_ACCESS_CODE
npx wrangler deploy
```

무료 요금제만으로 개인 동기화에 충분합니다. API 키나 접근 코드를 `wrangler.toml`, GitHub, HTML 또는 JavaScript 파일에 직접 적지 마세요.
