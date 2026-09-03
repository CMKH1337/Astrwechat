"use strict";
/**
 * 微信表情包 TypeScript 模块
 * 提供类型安全的表情访问和图片路径获取功能
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMOJI_CATEGORIES = exports.EmojiCategory = void 0;
exports.getEmojiPath = getEmojiPath;
exports.getEmojiInfo = getEmojiInfo;
exports.getEmojisByCategory = getEmojisByCategory;
exports.getAllEmojis = getAllEmojis;
exports.searchEmojis = searchEmojis;
exports.hasEmoji = hasEmoji;
exports.getEmojiNames = getEmojiNames;
exports.getRandomEmoji = getRandomEmoji;
/**
 * 表情类别枚举
 */
var EmojiCategory;
(function (EmojiCategory) {
    /** 人脸表情 */
    EmojiCategory["FACE"] = "face";
    /** 手势表情 */
    EmojiCategory["GESTURE"] = "gesture";
    /** 动物表情 */
    EmojiCategory["ANIMAL"] = "animal";
    /** 祝福表情 */
    EmojiCategory["BLESSING"] = "blessing";
    /** 其他表情 */
    EmojiCategory["OTHER"] = "other";
})(EmojiCategory || (exports.EmojiCategory = EmojiCategory = {}));
/**
 * 表情数据映射
 * 将表情名称映射到完整的表情信息
 */
const EMOJI_DATA = {
    // 人脸表情
    '微笑': { name: '微笑', category: EmojiCategory.FACE, path: 'assets/face/微笑.png' },
    '撇嘴': { name: '撇嘴', category: EmojiCategory.FACE, path: 'assets/face/撇嘴.png' },
    '色': { name: '色', category: EmojiCategory.FACE, path: 'assets/face/色.png' },
    '发呆': { name: '发呆', category: EmojiCategory.FACE, path: 'assets/face/发呆.png' },
    '得意': { name: '得意', category: EmojiCategory.FACE, path: 'assets/face/得意.png' },
    '流泪': { name: '流泪', category: EmojiCategory.FACE, path: 'assets/face/流泪.png' },
    '害羞': { name: '害羞', category: EmojiCategory.FACE, path: 'assets/face/害羞.png' },
    '闭嘴': { name: '闭嘴', category: EmojiCategory.FACE, path: 'assets/face/闭嘴.png' },
    '睡': { name: '睡', category: EmojiCategory.FACE, path: 'assets/face/睡.png' },
    '大哭': { name: '大哭', category: EmojiCategory.FACE, path: 'assets/face/大哭.png' },
    '尴尬': { name: '尴尬', category: EmojiCategory.FACE, path: 'assets/face/尴尬.png' },
    '发怒': { name: '发怒', category: EmojiCategory.FACE, path: 'assets/face/发怒.png' },
    '调皮': { name: '调皮', category: EmojiCategory.FACE, path: 'assets/face/调皮.png' },
    '呲牙': { name: '呲牙', category: EmojiCategory.FACE, path: 'assets/face/呲牙.png' },
    '惊讶': { name: '惊讶', category: EmojiCategory.FACE, path: 'assets/face/惊讶.png' },
    '难过': { name: '难过', category: EmojiCategory.FACE, path: 'assets/face/难过.png' },
    '囧': { name: '囧', category: EmojiCategory.FACE, path: 'assets/face/囧.png' },
    '抓狂': { name: '抓狂', category: EmojiCategory.FACE, path: 'assets/face/抓狂.png' },
    '吐': { name: '吐', category: EmojiCategory.FACE, path: 'assets/face/吐.png' },
    '偷笑': { name: '偷笑', category: EmojiCategory.FACE, path: 'assets/face/偷笑.png' },
    '愉快': { name: '愉快', category: EmojiCategory.FACE, path: 'assets/face/愉快.png' },
    '白眼': { name: '白眼', category: EmojiCategory.FACE, path: 'assets/face/白眼.png' },
    '傲慢': { name: '傲慢', category: EmojiCategory.FACE, path: 'assets/face/傲慢.png' },
    '困': { name: '困', category: EmojiCategory.FACE, path: 'assets/face/困.png' },
    '惊恐': { name: '惊恐', category: EmojiCategory.FACE, path: 'assets/face/惊恐.png' },
    '憨笑': { name: '憨笑', category: EmojiCategory.FACE, path: 'assets/face/憨笑.png' },
    '悠闲': { name: '悠闲', category: EmojiCategory.FACE, path: 'assets/face/悠闲.png' },
    '咒骂': { name: '咒骂', category: EmojiCategory.FACE, path: 'assets/face/咒骂.png' },
    '疑问': { name: '疑问', category: EmojiCategory.FACE, path: 'assets/face/疑问.png' },
    '嘘': { name: '嘘', category: EmojiCategory.FACE, path: 'assets/face/嘘.png' },
    '晕': { name: '晕', category: EmojiCategory.FACE, path: 'assets/face/晕.png' },
    '衰': { name: '衰', category: EmojiCategory.FACE, path: 'assets/face/衰.png' },
    '骷髅': { name: '骷髅', category: EmojiCategory.FACE, path: 'assets/face/骷髅.png' },
    '敲打': { name: '敲打', category: EmojiCategory.FACE, path: 'assets/face/敲打.png' },
    '再见': { name: '再见', category: EmojiCategory.FACE, path: 'assets/face/再见.png' },
    '擦汗': { name: '擦汗', category: EmojiCategory.FACE, path: 'assets/face/擦汗.png' },
    '抠鼻': { name: '抠鼻', category: EmojiCategory.FACE, path: 'assets/face/抠鼻.png' },
    '鼓掌': { name: '鼓掌', category: EmojiCategory.FACE, path: 'assets/face/鼓掌.png' },
    '坏笑': { name: '坏笑', category: EmojiCategory.FACE, path: 'assets/face/坏笑.png' },
    '右哼哼': { name: '右哼哼', category: EmojiCategory.FACE, path: 'assets/face/右哼哼.png' },
    '鄙视': { name: '鄙视', category: EmojiCategory.FACE, path: 'assets/face/鄙视.png' },
    '委屈': { name: '委屈', category: EmojiCategory.FACE, path: 'assets/face/委屈.png' },
    '快哭了': { name: '快哭了', category: EmojiCategory.FACE, path: 'assets/face/快哭了.png' },
    '阴险': { name: '阴险', category: EmojiCategory.FACE, path: 'assets/face/阴险.png' },
    '亲亲': { name: '亲亲', category: EmojiCategory.FACE, path: 'assets/face/亲亲.png' },
    '可怜': { name: '可怜', category: EmojiCategory.FACE, path: 'assets/face/可怜.png' },
    '笑脸': { name: '笑脸', category: EmojiCategory.FACE, path: 'assets/face/笑脸.png' },
    '生病': { name: '生病', category: EmojiCategory.FACE, path: 'assets/face/生病.png' },
    '脸红': { name: '脸红', category: EmojiCategory.FACE, path: 'assets/face/脸红.png' },
    '破涕为笑': { name: '破涕为笑', category: EmojiCategory.FACE, path: 'assets/face/破涕为笑.png' },
    '恐惧': { name: '恐惧', category: EmojiCategory.FACE, path: 'assets/face/恐惧.png' },
    '失望': { name: '失望', category: EmojiCategory.FACE, path: 'assets/face/失望.png' },
    '无语': { name: '无语', category: EmojiCategory.FACE, path: 'assets/face/无语.png' },
    '嘿哈': { name: '嘿哈', category: EmojiCategory.FACE, path: 'assets/face/嘿哈.png' },
    '捂脸': { name: '捂脸', category: EmojiCategory.FACE, path: 'assets/face/捂脸.png' },
    '机智': { name: '机智', category: EmojiCategory.FACE, path: 'assets/face/机智.png' },
    '皱眉': { name: '皱眉', category: EmojiCategory.FACE, path: 'assets/face/皱眉.png' },
    '耶': { name: '耶', category: EmojiCategory.FACE, path: 'assets/face/耶.png' },
    '吃瓜': { name: '吃瓜', category: EmojiCategory.FACE, path: 'assets/face/吃瓜.png' },
    '加油': { name: '加油', category: EmojiCategory.FACE, path: 'assets/face/加油.png' },
    '汗': { name: '汗', category: EmojiCategory.FACE, path: 'assets/face/汗.png' },
    '天啊': { name: '天啊', category: EmojiCategory.FACE, path: 'assets/face/天啊.png' },
    'Emm': { name: 'Emm', category: EmojiCategory.FACE, path: 'assets/face/Emm.png' },
    '社会社会': { name: '社会社会', category: EmojiCategory.FACE, path: 'assets/face/社会社会.png' },
    '旺柴': { name: '旺柴', category: EmojiCategory.FACE, path: 'assets/face/旺柴.png' },
    '好的': { name: '好的', category: EmojiCategory.FACE, path: 'assets/face/好的.png' },
    '打脸': { name: '打脸', category: EmojiCategory.FACE, path: 'assets/face/打脸.png' },
    '哇': { name: '哇', category: EmojiCategory.FACE, path: 'assets/face/哇.png' },
    '翻白眼': { name: '翻白眼', category: EmojiCategory.FACE, path: 'assets/face/翻白眼.png' },
    '666': { name: '666', category: EmojiCategory.FACE, path: 'assets/face/666.png' },
    '让我看看': { name: '让我看看', category: EmojiCategory.FACE, path: 'assets/face/让我看看.png' },
    '叹气': { name: '叹气', category: EmojiCategory.FACE, path: 'assets/face/叹气.png' },
    '苦涩': { name: '苦涩', category: EmojiCategory.FACE, path: 'assets/face/苦涩.png' },
    '裂开': { name: '裂开', category: EmojiCategory.FACE, path: 'assets/face/裂开.png' },
    '奸笑': { name: '奸笑', category: EmojiCategory.FACE, path: 'assets/face/奸笑.png' },
    // 手势表情
    '握手': { name: '握手', category: EmojiCategory.GESTURE, path: 'assets/gesture/握手.png' },
    '胜利': { name: '胜利', category: EmojiCategory.GESTURE, path: 'assets/gesture/胜利.png' },
    '抱拳': { name: '抱拳', category: EmojiCategory.GESTURE, path: 'assets/gesture/抱拳.png' },
    '勾引': { name: '勾引', category: EmojiCategory.GESTURE, path: 'assets/gesture/勾引.png' },
    '拳头': { name: '拳头', category: EmojiCategory.GESTURE, path: 'assets/gesture/拳头.png' },
    'OK': { name: 'OK', category: EmojiCategory.GESTURE, path: 'assets/gesture/OK.png' },
    '合十': { name: '合十', category: EmojiCategory.GESTURE, path: 'assets/gesture/合十.png' },
    '强': { name: '强', category: EmojiCategory.GESTURE, path: 'assets/gesture/强.png' },
    '拥抱': { name: '拥抱', category: EmojiCategory.GESTURE, path: 'assets/gesture/拥抱.png' },
    '弱': { name: '弱', category: EmojiCategory.GESTURE, path: 'assets/gesture/弱.png' },
    // 动物表情
    '猪头': { name: '猪头', category: EmojiCategory.ANIMAL, path: 'assets/animal/猪头.png' },
    '跳跳': { name: '跳跳', category: EmojiCategory.ANIMAL, path: 'assets/animal/跳跳.png' },
    '发抖': { name: '发抖', category: EmojiCategory.ANIMAL, path: 'assets/animal/发抖.png' },
    '转圈': { name: '转圈', category: EmojiCategory.ANIMAL, path: 'assets/animal/转圈.png' },
    // 祝福表情
    '庆祝': { name: '庆祝', category: EmojiCategory.BLESSING, path: 'assets/blessing/庆祝.png' },
    '礼物': { name: '礼物', category: EmojiCategory.BLESSING, path: 'assets/blessing/礼物.png' },
    '红包': { name: '红包', category: EmojiCategory.BLESSING, path: 'assets/blessing/红包.png' },
    '發': { name: '發', category: EmojiCategory.BLESSING, path: 'assets/blessing/發.png' },
    '福': { name: '福', category: EmojiCategory.BLESSING, path: 'assets/blessing/福.png' },
    '烟花': { name: '烟花', category: EmojiCategory.BLESSING, path: 'assets/blessing/烟花.png' },
    '爆竹': { name: '爆竹', category: EmojiCategory.BLESSING, path: 'assets/blessing/爆竹.png' },
    // 其他表情
    '嘴唇': { name: '嘴唇', category: EmojiCategory.OTHER, path: 'assets/other/嘴唇.png' },
    '爱心': { name: '爱心', category: EmojiCategory.OTHER, path: 'assets/other/爱心.png' },
    '心碎': { name: '心碎', category: EmojiCategory.OTHER, path: 'assets/other/心碎.png' },
    '啤酒': { name: '啤酒', category: EmojiCategory.OTHER, path: 'assets/other/啤酒.png' },
    '咖啡': { name: '咖啡', category: EmojiCategory.OTHER, path: 'assets/other/咖啡.png' },
    '蛋糕': { name: '蛋糕', category: EmojiCategory.OTHER, path: 'assets/other/蛋糕.png' },
    '凋谢': { name: '凋谢', category: EmojiCategory.OTHER, path: 'assets/other/凋谢.png' },
    '菜刀': { name: '菜刀', category: EmojiCategory.OTHER, path: 'assets/other/菜刀.png' },
    '炸弹': { name: '炸弹', category: EmojiCategory.OTHER, path: 'assets/other/炸弹.png' },
    '便便': { name: '便便', category: EmojiCategory.OTHER, path: 'assets/other/便便.png' },
    '太阳': { name: '太阳', category: EmojiCategory.OTHER, path: 'assets/other/太阳.png' },
    '月亮': { name: '月亮', category: EmojiCategory.OTHER, path: 'assets/other/月亮.png' },
    '玫瑰': { name: '玫瑰', category: EmojiCategory.OTHER, path: 'assets/other/玫瑰.png' }
};
/**
 * 获取所有表情数据的辅助函数
 */
function getAllEmojiData() {
    const result = [];
    for (const key in EMOJI_DATA) {
        if (EMOJI_DATA.hasOwnProperty(key)) {
            result.push(EMOJI_DATA[key]);
        }
    }
    return result;
}
/**
 * 按类别分组的表情数据
 */
exports.EMOJI_CATEGORIES = {
    [EmojiCategory.FACE]: getAllEmojiData().filter(emoji => emoji.category === EmojiCategory.FACE),
    [EmojiCategory.GESTURE]: getAllEmojiData().filter(emoji => emoji.category === EmojiCategory.GESTURE),
    [EmojiCategory.ANIMAL]: getAllEmojiData().filter(emoji => emoji.category === EmojiCategory.ANIMAL),
    [EmojiCategory.BLESSING]: getAllEmojiData().filter(emoji => emoji.category === EmojiCategory.BLESSING),
    [EmojiCategory.OTHER]: getAllEmojiData().filter(emoji => emoji.category === EmojiCategory.OTHER)
};
/**
 * 获取表情图片路径
 * @param name 表情名称
 * @returns 图片路径，如果表情不存在则返回 null
 *
 * @example
 * ```typescript
 * const path = getEmojiPath('微笑'); // 'assets/face/微笑.png'
 * const invalidPath = getEmojiPath('不存在'); // null
 * ```
 */
function getEmojiPath(name) {
    const emoji = EMOJI_DATA[name];
    return emoji ? emoji.path : null;
}
/**
 * 获取表情信息
 * @param name 表情名称
 * @returns 表情信息对象，如果表情不存在则返回 null
 *
 * @example
 * ```typescript
 * const emoji = getEmojiInfo('微笑');
 * // { name: '微笑', category: EmojiCategory.FACE, path: 'assets/face/微笑.png' }
 * ```
 */
function getEmojiInfo(name) {
    return EMOJI_DATA[name] || null;
}
/**
 * 根据类别获取表情列表
 * @param category 表情类别
 * @returns 该类别下的所有表情信息
 *
 * @example
 * ```typescript
 * const faceEmojis = getEmojisByCategory(EmojiCategory.FACE);
 * ```
 */
function getEmojisByCategory(category) {
    return exports.EMOJI_CATEGORIES[category];
}
/**
 * 获取所有表情信息
 * @returns 所有表情的信息数组
 *
 * @example
 * ```typescript
 * const allEmojis = getAllEmojis();
 * console.log(`总共有 ${allEmojis.length} 个表情`);
 * ```
 */
function getAllEmojis() {
    return getAllEmojiData();
}
/**
 * 搜索表情
 * @param keyword 搜索关键词
 * @returns 匹配的表情信息数组
 *
 * @example
 * ```typescript
 * const results = searchEmojis('笑');
 * // 返回包含 '微笑', '偷笑', '坏笑' 等的表情
 * ```
 */
function searchEmojis(keyword) {
    return getAllEmojiData().filter(emoji => emoji.name.indexOf(keyword) !== -1);
}
/**
 * 检查表情是否存在
 * @param name 表情名称
 * @returns 是否存在该表情
 *
 * @example
 * ```typescript
 * const exists = hasEmoji('微笑'); // true
 * const notExists = hasEmoji('不存在的表情'); // false
 * ```
 */
function hasEmoji(name) {
    return name in EMOJI_DATA;
}
/**
 * 获取表情名称列表
 * @param category 可选的类别筛选
 * @returns 表情名称数组
 *
 * @example
 * ```typescript
 * const allNames = getEmojiNames();
 * const faceNames = getEmojiNames(EmojiCategory.FACE);
 * ```
 */
function getEmojiNames(category) {
    if (category) {
        return getEmojisByCategory(category).map(emoji => emoji.name);
    }
    const names = [];
    for (const key in EMOJI_DATA) {
        if (EMOJI_DATA.hasOwnProperty(key)) {
            names.push(key);
        }
    }
    return names;
}
/**
 * 随机获取表情
 * @param category 可选的类别筛选
 * @returns 随机表情信息
 *
 * @example
 * ```typescript
 * const randomEmoji = getRandomEmoji();
 * const randomFaceEmoji = getRandomEmoji(EmojiCategory.FACE);
 * ```
 */
function getRandomEmoji(category) {
    const emojis = category ? getEmojisByCategory(category) : getAllEmojis();
    const randomIndex = Math.floor(Math.random() * emojis.length);
    return emojis[randomIndex];
}
/**
 * 默认导出对象，包含所有主要功能
 */
const WeChatEmojis = {
    // 枚举和类型
    EmojiCategory,
    // 数据
    EMOJI_CATEGORIES: exports.EMOJI_CATEGORIES,
    // 工具函数
    getEmojiPath,
    getEmojiInfo,
    getEmojisByCategory,
    getAllEmojis,
    searchEmojis,
    hasEmoji,
    getEmojiNames,
    getRandomEmoji
};
exports.default = WeChatEmojis;
