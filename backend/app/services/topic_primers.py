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



PROGRAM_LINKING = {
    "card": {
        "title": "程序的链接：从目标文件到可执行程序",
        "objective": "能区分编译与链接，解释符号解析和重定位，并定位缺少定义与重复定义两类链接错误。",
        "key_points": [
            "以常见 C 工具链为例，源文件分别编译成目标文件；目标文件包含机器代码、数据、符号表和重定位信息。链接器组合多个目标文件及所需库，生成可执行文件或共享库。",
            "符号解析把一个目标文件中的外部引用与其他目标文件或库中的定义对应起来。例如 main.o 调用 add，但定义位于 add.o，链接器需要找到该定义。",
            "重定位根据最终布局修正代码或数据中的地址引用。单独编译时尚不知道其他模块的最终地址，因此目标文件记录待修正的位置，而不是提前知道全部地址。",
            "静态链接通常把选中的库目标代码纳入输出文件；动态链接保留对共享库及符号的依赖，由加载器和动态链接器在装载或运行时完成相关工作。动态链接不代表完全没有链接阶段。",
            "声明告诉编译器名称的类型和调用方式，定义才提供函数体或存储。声明存在不保证链接成功；未找到所需定义会出现未定义引用，冲突的多个强定义可能导致重复定义错误。",
        ],
        "target_concepts": ["目标文件", "符号解析", "重定位", "静态链接", "动态链接"],
        "example": "main.c 声明 int add(int, int); 并在 main 中返回 add(2,3)，add.c 定义 int add(int a,int b){return a+b;}。分别执行 cc -c main.c 与 cc -c add.c 得到 main.o、add.o；cc main.o add.o -o demo 才把两者链接起来。若只执行 cc main.o -o demo，链接器通常报告 add 的未定义引用。这个例子中的两个源文件都可以通过单独编译，故出错阶段不能仅凭‘构建失败’判断。",
        "common_confusion": "头文件声明不会自动带来函数实现；编译成功不保证链接成功。这里描述的是常见原生 C 工具链，不把所有语言的解释执行、JIT 或模块加载都当作同一种流程。具体报错措辞及符号处理细节随平台和工具链变化。",
        "success_criteria": "给定两个目标文件，指出谁提供定义、谁发出引用；解释缺少 add.o 为什么导致链接失败，并说明何时需要修正地址。",
    },
    "questions": [
        {
            "q_type": "single", "difficulty": "easy", "learning_target": "区分声明与链接所需的定义",
            "evidence_claim": "能从缺失目标文件定位未定义引用的原因",
            "question": "main.o 引用了 add，add.o 提供唯一的 add 定义。只用 main.o 链接时报告 add 未定义，最直接的修复是哪项？",
            "options": ["把 main.c 中的函数声明再复制一次", "把 add.o 或提供该定义的库加入链接输入", "只把输出文件名改成 add", "删除全部重定位信息"],
            "answer_indexes": [1], "explanation": "声明不提供函数体；链接器需要在实际输入目标文件或库中找到 add 的定义。",
            "variant": {"type": "concept_choice", "validated": True,
                "prompt": "util.o 定义了 print_result，report.o 引用它。两者分别编译成功，链接只输入 report.o。应该补充什么？",
                "options": ["util.o 或包含它的库", "再写一遍同名声明", "一个不同的输出文件名"], "answer_indexes": [0]},
        },
        {
            "q_type": "single", "difficulty": "medium", "learning_target": "理解重定位与模块最终布局的关系",
            "evidence_claim": "能区分符号解析与地址修正",
            "question": "链接器已找到函数的定义，但该函数在输出文件中的位置与单独编译时假定的位置不同。修正调用处地址引用属于什么工作？",
            "options": ["符号解析", "宏展开", "重定位", "常量折叠"],
            "answer_indexes": [2], "explanation": "符号解析找到引用对应的定义，重定位则依据最终布局修正地址引用。",
            "variant": {"type": "concept_choice", "validated": True,
                "prompt": "两个目标文件合并后，全局数据的位置发生变化，访问该数据的地址引用需要随之更新。这属于哪项？",
                "options": ["符号解析", "重定位", "宏展开"], "answer_indexes": [1]},
        },
        {
            "q_type": "single", "difficulty": "medium", "learning_target": "区分静态链接与动态链接",
            "evidence_claim": "能判断输出文件对共享库的运行依赖",
            "question": "某可执行文件在启动时需要加载特定共享库。以下哪项最符合这种机制？",
            "options": ["库中所有实现一定已完整复制进可执行文件", "程序从未经过任何链接处理", "头文件声明在运行时自动变成实现", "输出保留共享库依赖，装载时由加载器和动态链接器参与处理"],
            "answer_indexes": [3], "explanation": "动态链接保留对共享库和符号的依赖，相关绑定可发生在装载或运行时。",
            "variant": {"type": "concept_choice", "validated": True,
                "prompt": "把选中的库目标代码纳入输出文件，以减少对该共享库的运行依赖，通常对应哪种方式？",
                "options": ["静态链接", "只添加头文件", "只进行语法检查"], "answer_indexes": [0]},
        },
    ],
}

# A separate, reviewed scenario bank for verification after the lecture/practice
# pair. These are different reasoning situations, not renamed original items.
PROGRAM_LINKING_VERIFICATION_QUESTIONS = [
    {
        "q_type": "single", "difficulty": "medium",
        "learning_target": "定位跨模块重复定义并保持唯一外部定义",
        "evidence_claim": "能将冲突的变量实现与可重复的声明区分开",
        "question": "配置模块和日志模块各自提供了全局变量 log_level 的一个强定义，单独编译均成功，合并时报重复定义。若二者应共享同一份状态，应如何组织代码？",
        "options": ["保留两个强定义，只调整目标文件排列", "让一个模块保留定义，另一个模块只引用相应外部声明", "在两个模块都增加同名强定义", "把可执行文件重命名"],
        "answer_indexes": [1],
        "explanation": "共享的外部对象应由一个模块提供定义，其他模块通过声明引用它；重新排序不能消除冲突的强定义。",
        "variant": {"type": "concept_choice", "validated": True,
            "prompt": "两个插件把同一个非内联工具函数的实现复制进各自源文件，最终静态组合时报该函数多重定义。要共享这一实现，哪种调整符合模块边界？",
            "options": ["将实现集中到一个工具模块，其余模块保留声明并链接工具模块", "为每份实现增加一份相同声明即可", "只改调用位置，保留全部冲突强定义"], "answer_indexes": [0]},
    },
    {
        "q_type": "single", "difficulty": "medium",
        "learning_target": "判断动态库的部署依赖与构建产物的区别",
        "evidence_claim": "能根据运行环境缺少共享库定位故障阶段",
        "question": "图像工具在开发机上构建并运行成功，复制可执行文件到新机器后，启动器报告找不到它依赖的共享图像库。下列哪项最直接针对这个问题？",
        "options": ["在源码里重复增加库函数声明", "把所有源文件再单独编译一次但不部署任何库", "部署兼容的共享库，并让运行环境能够找到它", "认为开发机链接成功意味着所有机器都自带该库"],
        "answer_indexes": [2],
        "explanation": "动态链接输出保留运行时共享库依赖。开发机成功不能替代目标机器上的库部署及查找配置。",
        "variant": {"type": "concept_choice", "validated": True,
            "prompt": "离线设备上的应用已把压缩库的目标代码静态纳入可执行文件。维护者只替换构建目录中的静态库文件，没有重新链接或更换设备上的可执行文件。设备会自动使用新库实现吗？",
            "options": ["会，静态库总在启动时重新载入", "不会，需重新链接并部署含新代码的可执行文件", "会，只要修改头文件声明"], "answer_indexes": [1]},
    },
    {
        "q_type": "single", "difficulty": "medium",
        "learning_target": "将最终布局用于修正绝对地址引用",
        "evidence_claim": "能在指定地址模型中推导链接后的引用值",
        "question": "在一个简化的链接示例中，跳转表的一项需要保存目标函数的绝对地址。目标文件暂填 0，并记录了需要修正的位置。最终布局把该函数放在地址 8192，该表项应如何处理？",
        "options": ["保留 0，因为编译已经结束", "填入源文件行号", "删除该函数的定义", "根据重定位记录把表项修正为 8192"],
        "answer_indexes": [3],
        "explanation": "这里明确指定表项存放绝对地址；链接器根据最终布局与重定位记录把占位值修正为目标地址。",
        "variant": {"type": "concept_choice", "validated": True,
            "prompt": "另一个简化示例中，数据表项须保存全局缓冲区起点之后 12 字节处的绝对地址。合并布局后缓冲区起点为 5000，该表项的最终值应是多少？",
            "options": ["12", "5000", "5012"], "answer_indexes": [2]},
    },
]


def deterministic_topic_primer(goal: str, *, verification: bool = False) -> tuple[dict[str, Any], str] | None:
    normalized = "".join(str(goal or "").casefold().split())
    if any(alias in normalized for alias in ("程序的链接", "程序链接", "链接器", "静态链接", "动态链接", "programlinking", "linker")):
        artifact = deepcopy(PROGRAM_LINKING)
        if verification:
            artifact["questions"] = deepcopy(PROGRAM_LINKING_VERIFICATION_QUESTIONS)
            return artifact, "curated.program_linking.verification.v1"
        return artifact, "curated.program_linking.v1"
    if any(alias in normalized for alias in (
        "朴素贝叶斯", "naivebayes", "naïvebayes",
    )):
        return deepcopy(NAIVE_BAYES), "curated.naive_bayes.v1"
    if any(alias in normalized for alias in (
        "条件概率", "贝叶斯更新", "贝叶斯公式", "bayesupdate", "bayes'theorem",
    )):
        return deepcopy(CONDITIONAL_PROBABILITY), "curated.conditional_probability.v1"
    return None
