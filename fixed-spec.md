# Fixed Schedule 規則規格書 — 2026-09

> 依用戶定義的規則，生成 `fixed.csv`。本文件固定規則，作為生成與驗證的唯一依據。

## 概覽
- **期間**：2026-09-01 → 2026-09-30
- **人員 (4)**：Andy, Jessica, Tina, Alan
- **Public holiday**：2026-09-26（Sat；本身已是 wsat 週末日）
- **output**：`fixed.csv`（純 CSV 排班表）+ 本驗證報告

## 記法定義（用戶口徑，重要）
| 記法 | 含義 | 規則 |
|------|------|------|
| `m+d` | **同一天**同一人 Morning + Deployment 雙班 | **允許**的 relief / 妥協（階梯第 2、3 層） |
| `d+m` | **跨天**：昨天 Deployment → 今天 Morning | **禁止，紅色** |
| `d+wsat` | 昨天 Deployment → 今天 Weekend support | **禁止，紅色** |
| 連續 d | 同一人**連續兩天** Deployment | 妥協手段（階梯第 4 層） |
| `t` | 星期四的 Deployment，**獨立計數，不計入 d** | 公平 scope |

## 公平目標（重要性由高到低）
1. **檔 1**：`wsat = wsun = t = h` 均衡
   - 若無法全公平，優先順序：**wsat → wsun → t → h**；holiday 由 `wsat+wsun+t+h` 總和較少者按序填。
2. **檔 2**：`m = d` 均衡（`d` 不含星期四；星期四 d 只在 `t` 計）

## 硬約束（可用性，永不放棄）
- 某人當日 unavailable → 當日不可排任何班。
- 每個 workday（Mon–Fri 非假日）必須填 m 和 d（都由 available 人填）。
- 每個 WS day（Sat/Sun/holiday）必須填 w（由 available 人填）。

## 紅色禁止（任何妥協不得違反）
1. `d+m`：昨天 d，今天 m（昨天 d 者今天不可 m）。
2. `d+wsat`：昨天 d，今天 wsat（昨天 d 者今天不可 wsat support）。
3. （同一人同日雙職 m+d 屬允許 relief，非紅色 — 由階梯控制頻度。）

## 妥協階梯（由最優往下，逐層觸發；每層觸發後先全力調動尋求公平，無效才進下一層）
1. **理想**：完全公平、無紅色（無 m+d 同日、無連續 d、無 wsun→m）。
2. **Andy take up m+d**（可複數；Andy 此層使用次數 > 下一層）。
3. **其他同事平均 take up m+d**（每人一天、盡量平均）。
4. **任何人連續 2 天 Deployment**。
5. **`wsun / holiday` support 後一天的 Morning**（用戶 (1)，最後手段）。
6. 仍難解（無法公平也無法消除紅/壓到最低）→ 出現紅色告示，**列出 violated 的 rule**。

## 生成策略
按 WS days 與 workdays 分開填：
- 先填 WS days（數量少），依檔 1 的 wsat/wsun/h 目標 + `d+wsat` 禁止 + 已填 d 的次日阻塞。
- 再填 workday 的 d 與 m：避免 `d+m`、同日雙人分職；公平 m/d；僅在需要時呼叫 m+d / 連續 d / wsun→m 階梯。
- 全程硬守可用性與「d 後次日不得 m/wsat」。
- 產出後以本規格書的 validator 檢查，回報：公平落差、m+d 使用次數、連續 d 次數、wsun→m 次數、以及任何殘留紅色（若完全無法消除）。