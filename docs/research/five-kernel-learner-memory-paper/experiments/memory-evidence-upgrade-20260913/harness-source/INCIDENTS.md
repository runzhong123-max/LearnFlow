# 运行与校验修订记录

run-01 在首次原生调用之前冻结协议、14 个案例、80 条字段断言与全部来源；完整执行14/14，基础设施错误0，源码未漂移，原始字节重开复算一致，进程exit0。初版校验结果12/14，其中 nonresponse_and_idempotence 和 relapse_invalidates_current_stability 均出现来源门 review_evidence_fields。

原始数据定位：不会作答的 Attempt 2 和再次答错的 Attempt 4 先经 review API 建为 review 角色，后由正式 create_remediation_case（共享 remediation.py 的原生行为）改为该纠错链的 original 来源；原生 RemediationCase 通过 source_attempt_id、remediation_case_id、evidence_event_ids 保留绑定。初版 verifier 错误要求最终角色只能为 review，因此误拒绝这条合法业务转换。

修正只允许以下严格分支：实际 review Event 的 passed=false，最终 Attempt.role=original，存在同 owner/scope/item 的真实 RemediationCase，source_attempt_id 与 Attempt ID 一致、Attempt.remediation_case_id 一致，Case evidence_event_ids 包含当前 review Event 与对应同scope remediation_started Event，且所有引用均存在。独立公开题目计算、实际判分、辅助等级、稳定资格、题型版本和其他来源门不放松。增加八个正例/污染负例，校准测试由35变为43。

run-02 重新冻结后，从头执行同一14个案例与同一80条主字段断言；不复用首轮成绩作为独立样本。未改变任何生产代码、案例、输入、阈值或主断言。run-01 的全部原始数据和8份原版harness源文件自动保存在其目录，初版12/14不作为修正后正式通过率。

此外，run-01 的 relapse 案例确实出现当前工作台 evidence_state=none、Knowledge.retention_status=needs_review，而长期 Knowledge.mastery 仍 level=stable。这个独立的作者安全挑战失败是真实原始事实，不能随来源门修正而抹去。后续报告须分开说明工作台当前读取正确与长期未限定stable标记未失效。
