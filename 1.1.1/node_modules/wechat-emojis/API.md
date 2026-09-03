# 微信表情包 TypeScript API 文档

## 概述

`wechatEmoji.ts` 提供了完整的 TypeScript 支持，让你可以类型安全地访问微信表情包资源。

## 安装和使用

### 1. 通过 NPM 安装（推荐）

```bash
# 安装包
npm install wechat-emojis

# 复制表情资源到项目的 public 目录（重要）
mkdir -p public/assets
cp -r node_modules/wechat-emojis/assets/* public/assets/
```

使用 NPM 包：

```typescript
import WeChatEmojis, {
  EmojiCategory,
  getEmojiPath,
  getEmojisByCategory,
  searchEmojis
} from 'wechat-emojis';
```

### 2. 直接使用 TypeScript 源文件

```typescript
import WeChatEmojis, {
  EmojiCategory,
  getEmojiPath,
  getEmojisByCategory,
  searchEmojis
} from './wechatEmoji';
```

### 3. 编译后使用 JavaScript

```bash
# 编译 TypeScript
npx tsc wechatEmoji.ts --target es2017 --module commonjs

# 在 Node.js 中使用
const { getEmojiPath, EmojiCategory } = require('./wechatEmoji.js');
```

## API 参考

### 类型定义

#### `EmojiCategory` 枚举

```typescript
enum EmojiCategory {
  FACE = 'face',      // 人脸表情
  GESTURE = 'gesture', // 手势表情
  ANIMAL = 'animal',   // 动物表情
  BLESSING = 'blessing', // 祝福表情
  OTHER = 'other'      // 其他表情
}
```

#### `EmojiInfo` 接口

```typescript
interface EmojiInfo {
  name: string;           // 表情名称
  category: EmojiCategory; // 表情类别
  path: string;           // 图片文件路径
  englishName?: string;   // 英文名称（可选）
}
```

#### `EmojiName` 类型

包含所有有效表情名称的联合类型，提供编译时类型检查。

### 核心函数

#### `getEmojiPath(name: EmojiName): string | null`

获取表情图片路径。

```typescript
const path = getEmojiPath('微笑'); // 'assets/face/微笑.png'
const invalid = getEmojiPath('不存在'); // null
```

#### `getEmojiInfo(name: EmojiName): EmojiInfo | null`

获取表情详细信息。

```typescript
const emoji = getEmojiInfo('微笑');
// { name: '微笑', category: EmojiCategory.FACE, path: 'assets/face/微笑.png' }
```

#### `getEmojisByCategory(category: EmojiCategory): EmojiInfo[]`

按类别获取表情列表。

```typescript
const faceEmojis = getEmojisByCategory(EmojiCategory.FACE);
console.log(`人脸表情数量: ${faceEmojis.length}`); // 75
```

#### `getAllEmojis(): EmojiInfo[]`

获取所有表情信息。

```typescript
const allEmojis = getAllEmojis();
console.log(`总表情数量: ${allEmojis.length}`); // 109
```

#### `searchEmojis(keyword: string): EmojiInfo[]`

搜索包含关键词的表情。

```typescript
const laughEmojis = searchEmojis('笑');
// 返回包含 '微笑', '偷笑', '坏笑' 等的表情
```

#### `hasEmoji(name: string): name is EmojiName`

检查表情是否存在（类型守卫）。

```typescript
if (hasEmoji('微笑')) {
  // TypeScript 知道这里 '微笑' 是有效的 EmojiName
  const path = getEmojiPath('微笑');
}
```

#### `getEmojiNames(category?: EmojiCategory): string[]`

获取表情名称列表。

```typescript
const allNames = getEmojiNames();
const faceNames = getEmojiNames(EmojiCategory.FACE);
```

#### `getRandomEmoji(category?: EmojiCategory): EmojiInfo`

随机获取表情。

```typescript
const randomEmoji = getRandomEmoji();
const randomFaceEmoji = getRandomEmoji(EmojiCategory.FACE);
```

## 使用示例

### React 组件示例

```typescript
import React from 'react';
import { getEmojiPath, getEmojisByCategory, EmojiCategory } from 'wechat-emojis';

const EmojiPicker: React.FC = () => {
  const faceEmojis = getEmojisByCategory(EmojiCategory.FACE);

  return (
    <div className="emoji-picker">
      {faceEmojis.map(emoji => (
        <img
          key={emoji.name}
          src={getEmojiPath(emoji.name)}
          alt={emoji.name}
          title={emoji.name}
          className="emoji-item"
          onClick={() => console.log(`选择了: ${emoji.name}`)}
        />
      ))}
    </div>
  );
};
```

### Vue 组件示例

```vue
<template>
  <div class="emoji-grid">
    <img
      v-for="emoji in emojis"
      :key="emoji.name"
      :src="getEmojiPath(emoji.name)"
      :alt="emoji.name"
      :title="emoji.name"
      @click="selectEmoji(emoji)"
    />
  </div>
</template>

<script setup lang="ts">
import { getEmojisByCategory, getEmojiPath, EmojiCategory } from 'wechat-emojis';

const emojis = getEmojisByCategory(EmojiCategory.FACE);

const selectEmoji = (emoji: EmojiInfo) => {
  console.log(`选择了表情: ${emoji.name}`);
};
</script>
```

## 数据统计

- **总表情数量**: 109 个
- **人脸表情**: 75 个
- **手势表情**: 10 个
- **动物表情**: 4 个
- **祝福表情**: 7 个
- **其他表情**: 13 个

## 注意事项

1. **类型安全**: 使用 `EmojiName` 类型可以在编译时检查表情名称的有效性
2. **路径相对性**: 返回的路径是相对于项目根目录的
3. **兼容性**: 编译目标为 ES2017，兼容现代浏览器和 Node.js
4. **性能**: 所有数据在模块加载时预计算，查询性能优秀
