"""Small, reviewed offline primers for common foundational learning goals.

These are not a second curriculum system.  They are a quality floor for the
focused-learning artifact generator when the configured model is unavailable.
Unknown topics still use learner-provided material or the transparent generic
fallback in ``micro_learning``.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any


NAIVE_BAYES = {
    "card": {
        "title": "朴素贝叶斯分类器：用概率比较类别",
        "objective": "能解释朴素贝叶斯如何由先验概率和特征似然计算分类分数，并说明条件独立假设与拉普拉斯平滑的作用。",
        "key_points": [
            "分类时比较每个类别的后验概率：P(C|x) 与 P(C)×P(x₁|C)×…×P(xₙ|C) 成正比。分母 P(x) 对所有类别相同，所以只需比较右侧分数。",
            "“朴素”指模型假设：给定类别 C 后，各个特征彼此条件独立。它不是说特征在现实中完全独立，也不是说类别彼此独立。",
            "训练阶段从数据估计类别先验 P(C) 和各特征在类别下的似然 P(xᵢ|C)；预测阶段通常累加对数概率，避免许多小概率相乘造成数值下溢。",
            "离散特征中，训练集里没出现过的词会让乘积变成 0；拉普拉斯平滑通过加入伪计数避免一个未见特征否决整个类别。",
            "多项式朴素贝叶斯常用于词频，伯努利版本关注特征是否出现，高斯版本用正态分布描述连续特征。",
        ],
        "target_concepts": ["后验概率", "条件独立", "先验概率", "似然", "拉普拉斯平滑"],
        "example": "垃圾邮件分类中，类别是“垃圾/正常”，特征可以是“免费”“中奖”等词是否出现。模型先看两类邮件原本的比例，再看这些词分别在两类邮件中出现的概率。即使词之间并非真的独立，这个近似仍常能得到有效的分类边界。",
        "common_confusion": "P(特征|类别) 是似然，P(类别|特征) 才是分类需要的后验；条件独立只在给定类别后成立。朴素贝叶斯输出的数值也不一定是校准良好的真实概率。",
        "success_criteria": "不看讲义写出分类分数的结构，解释“朴素”假设，并判断零频问题应如何处理。",
    },
    "questions": [
        {
            "q_type": "single",
            "difficulty": "easy",
            "learning_target": "识别朴素贝叶斯的条件独立假设",
            "evidence_claim": "能够区分条件独立、无条件独立和类别独立",
            "question": "朴素贝叶斯中的“朴素”假设最准确地表示什么？",
            "options": [
                "给定类别后，各特征彼此条件独立",
                "所有特征在任何情况下都完全独立",
                "所有类别出现的先验概率都相同",
                "每个样本只能包含一个有效特征",
            ],
            "answer_indexes": [0],
            "explanation": "模型把联合似然近似为各特征条件似然的乘积；这个分解依赖给定类别后的条件独立假设。",
            "variant": {
                "type": "concept_choice",
                "validated": True,
                "prompt": "若已知邮件属于垃圾邮件，模型把“免费”和“中奖”两个词如何处理？",
                "options": [
                    "近似认为二者条件独立，并相乘各自的条件概率",
                    "认为两个词在所有邮件中都绝对独立",
                    "只保留其中频率更高的词",
                    "忽略类别先验，只比较词数",
                ],
                "answer_indexes": [0],
            },
        },
        {
            "q_type": "single",
            "difficulty": "medium",
            "learning_target": "理解朴素贝叶斯的分类分数",
            "evidence_claim": "能够识别预测时需要比较的先验与似然组合",
            "question": "对同一个样本 x 比较多个类别时，通常可以直接比较哪一项？",
            "options": [
                "P(C)×∏P(xᵢ|C)",
                "只比较 P(C)，忽略所有特征",
                "只比较 P(x)，因为它随类别变化",
                "把所有 P(C|xᵢ) 直接相加",
            ],
            "answer_indexes": [0],
            "explanation": "贝叶斯公式的分母 P(x) 对候选类别相同，不影响最大值所在类别。",
            "variant": {
                "type": "concept_choice",
                "validated": True,
                "prompt": "实际实现常把这些概率转换为对数后相加，主要解决什么问题？",
                "options": [
                    "避免许多小概率连乘造成数值下溢",
                    "让条件独立假设变成严格事实",
                    "自动把所有类别先验改成相同",
                    "不再需要估计特征似然",
                ],
                "answer_indexes": [0],
            },
        },
        {
            "q_type": "single",
            "difficulty": "medium",
            "learning_target": "理解拉普拉斯平滑处理零频问题",
            "evidence_claim": "能够在未见特征导致零似然时选择正确处理方法",
            "question": "某个词在训练集的“正常邮件”中从未出现，直接估计会使该类别的乘积为 0。常用的处理方法是什么？",
            "options": [
                "使用拉普拉斯平滑加入伪计数",
                "永久删除“正常邮件”类别",
                "把该词的条件概率强制设为 1",
                "只用测试集重新计算训练标签",
            ],
            "answer_indexes": [0],
            "explanation": "拉普拉斯平滑避免未见事件获得零概率，同时仍保留训练数据带来的频率差异。",
            "variant": {
                "type": "concept_choice",
                "validated": True,
                "prompt": "如果不做平滑，一个未见特征会产生什么后果？",
                "options": [
                    "该类别的联合似然可能被整个乘成 0",
                    "只会略微提高该类别分数",
                    "只会改变类别先验而不影响似然",
                    "会自动切换为高斯朴素贝叶斯",
                ],
                "answer_indexes": [0],
            },
        },
    ],
}


CONDITIONAL_PROBABILITY = {
    "card": {
        "title": "条件概率与贝叶斯更新",
        "objective": "能区分先验、似然和后验，并用贝叶斯公式说明新证据如何更新判断。",
        "key_points": [
            "条件概率 P(A|B)=P(A∩B)/P(B) 表示已知 B 发生后，在缩小后的样本空间里 A 的概率。",
            "贝叶斯公式 P(H|E)=P(E|H)P(H)/P(E) 把假设的先验 P(H) 与证据的似然 P(E|H) 合成为后验 P(H|E)。",
            "P(E|H) 与 P(H|E) 方向不同：检测灵敏度高，不代表检测为阳性时患病概率就一定高；还必须考虑基础发生率。",
            "新证据到来后，当前后验可以成为下一轮更新的先验，因此贝叶斯更新是一种连续修正信念的过程。",
        ],
        "target_concepts": ["条件概率", "先验", "似然", "后验", "基础发生率"],
        "example": "某病患病率为 1%，检测对患者有 90% 概率阳性，对健康者有 10% 概率误报。阳性来自患者的概率质量是 0.01×0.90=0.009，来自健康者的是 0.99×0.10=0.099，所以阳性后的患病概率约为 0.009/(0.009+0.099)=8.3%，并不是 90%。",
        "common_confusion": "最常见错误是把 P(证据|假设) 当成 P(假设|证据)，或者忽略先验基础发生率。",
        "success_criteria": "能标出一个情境中的先验、似然和后验，并正确解释为什么二者条件方向不能交换。",
    },
    "questions": [
        {
            "q_type": "single",
            "difficulty": "easy",
            "learning_target": "区分似然和后验",
            "evidence_claim": "能够识别条件概率的方向",
            "question": "在医学检测中，“已患病的人检测为阳性的概率”对应哪一项？",
            "options": ["P(阳性|患病)", "P(患病|阳性)", "P(患病)", "P(阳性)"],
            "answer_indexes": [0],
            "explanation": "已知条件写在竖线右侧，因此这是证据在假设成立时出现的似然。",
            "variant": {
                "type": "concept_choice",
                "validated": True,
                "prompt": "“看到阳性结果后真正患病的概率”对应哪一项？",
                "options": ["P(阳性|患病)", "P(患病|阳性)", "P(未患病)", "P(阴性|患病)"],
                "answer_indexes": [1],
            },
        },
        {
            "q_type": "single",
            "difficulty": "medium",
            "learning_target": "理解基础发生率对后验的影响",
            "evidence_claim": "能够判断先验很低时高灵敏度不必然产生高后验",
            "question": "一种疾病非常罕见。即使检测灵敏度较高，阳性后的患病概率仍可能不高，主要因为还要考虑什么？",
            "options": ["疾病的先验基础发生率和假阳性率", "题目中使用的变量名称", "样本记录的排列顺序", "是否把概率写成百分数"],
            "answer_indexes": [0],
            "explanation": "后验同时由先验和似然决定；罕见病的大量健康人可能贡献更多假阳性。",
            "variant": {
                "type": "concept_choice",
                "validated": True,
                "prompt": "获得第二条独立证据后，上一轮后验通常扮演什么角色？",
                "options": ["下一轮更新的先验", "永远不再使用的常数", "新的假阳性率", "样本空间大小"],
                "answer_indexes": [0],
            },
        },
    ],
}


def deterministic_topic_primer(goal: str) -> tuple[dict[str, Any], str] | None:
    normalized = "".join(str(goal or "").casefold().split())
    if any(alias in normalized for alias in (
        "朴素贝叶斯", "naivebayes", "naïvebayes",
    )):
        return deepcopy(NAIVE_BAYES), "curated.naive_bayes.v1"
    if any(alias in normalized for alias in (
        "条件概率", "贝叶斯更新", "贝叶斯公式", "bayesupdate", "bayes'theorem",
    )):
        return deepcopy(CONDITIONAL_PROBABILITY), "curated.conditional_probability.v1"
    return None
