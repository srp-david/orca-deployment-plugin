// `orca plugin check` 가 패널을 시나리오마다 한 번 그린다. 워커가 실제 파일(~/.prod-deploy)을 읽으므로
// 여기서는 첫 화면만 본다.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {}
})
