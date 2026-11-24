"""模型预测（个股预测模型的每日结果）。

只读 MySQL 的 ``stock_predict_daily``：预测由 A 股管道每日同步后写入，本包不训练、
不推理。
"""

from . import data  # noqa: F401
