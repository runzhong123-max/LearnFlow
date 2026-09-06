# 参考校验

在独立 Python 环境中安装 `jsonschema==4.26.0`，从本目录执行：

```sh
python validate_examples.py
```

需要更新报告时使用 `python validate_examples.py --report`。脚本只在该参数下写入报告，不改 schema 与样例。

脚本提供设计包的参考验证，不能直接替代生产 Validator。详见 [本次报告](validation-report.md)。
