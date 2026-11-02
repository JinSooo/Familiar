---
name: familiar-pet
description: 为 Familiar（灵宠）做一只新的桌宠：从文字描述或参考图生成动画图集，打包成 Familiar 能直接读的宠物文件夹。用户说"做一只桌宠 / 自定义宠物 / 换个形象"时使用。
---

# 做一只 Familiar 桌宠

产出一个宠物文件夹，放进用户给的宠物目录（默认 `~/.familiar/pets/<id>/`）。Familiar 打开设置「宠物」页时会读到它。

## 格式

宠物文件夹兼容 ChatGPT 宠物格式：

```
<id>/
  pet.json             {"id","displayName","description","spritesheetPath":"spritesheet.webp"}
  spritesheet.webp     1536×1872，8 列 × 9 行，每格 192×208，透明底
  familiar.json        可选：Familiar 自己的动作
  familiar-extra.webp  可选：1536 × (行数×208)
```

每行从最左格开始放帧，用不到的格子保持全透明。

|  行 | 状态          | 帧数 | Familiar 里什么时候播                     |
| --: | ------------- | ---: | ----------------------------------------- |
|   0 | idle          |    6 | 待机；轻微呼吸、眨眼，不要大动作          |
|   1 | running-right |    8 | 被拖着往右走，面朝右                      |
|   2 | running-left  |    8 | 往左，面朝左（可以由 running-right 镜像） |
|   3 | waving        |    4 | 单击、每天第一次见面，打招呼              |
|   4 | jumping       |    5 | 跳起再落回原位                            |
|   5 | failed        |    8 | 出错，沮丧                                |
|   6 | waiting       |    6 | 需要用户批准或回答                        |
|   7 | running       |    6 | 思考、干活（比如看书、敲键盘），不是跑步  |
|   8 | review        |    6 | 回复好了等你看                            |

扩展行，没有时 Familiar 用上面的行代替：

| 状态      | 帧数 | 用途               |
| --------- | ---: | ------------------ |
| listening |    6 | 用户在打字，竖耳听 |
| talking   |    6 | 正在回复，张嘴说话 |
| sleeping  |    6 | 深夜没人理时睡着   |
| petted    |    6 | 被摸头，开心       |
| poked     |    4 | 连点三下，被戳到   |
| worried   |    6 | 担心               |

## 步骤

1. **定形象**。从用户的描述或参考图里定下名字、一句英文描述、`id`（小写字母、数字、`-`），不能用 `xiaohei-q`、`dango`、`matsuko`、`momo`。信息不够时问一两个问题，不要猜。
2. **先画标准形象**。用你能用的生图工具（Codex 的 `$imagegen`，或其他）画一张全身正面像：一个紧凑的轮廓，缩到 192×208 还看得清，纯色背景（选一个和宠物颜色反差大的颜色，方便抠图），没有文字、阴影和场景。给用户看一眼再继续。
3. **逐行画动作条**。每个状态一张横条，帧数按上表，等距排开，帧之间留空。每次都把标准形象作为参考图附上，保持脸、比例、配色、描边一致。不要速度线、汗滴、星星这类脱离身体的特效。至少要 9 个基础状态；扩展行能做就做，listening、talking、sleeping 最常用。
4. **切帧、抠图**。把每张横条按帧数等分切开（同一行的帧保持同样大小的画布，不要各自裁边），去掉背景色变成透明 PNG，放进 `frames/<状态>/01.png、02.png …`。
5. **打包**：

   ```bash
   uv run <本技能目录>/scripts/pack.py frames <宠物目录>/<id> \
     --id <id> --name <显示名> --description "<英文一句话>"
   ```

   脚本检查帧数，用同一比例缩放所有行，让宠物站在格子底部居中，并写出 `pet.json`、图集和 `frames/preview.png`。没有 `running-left` 文件夹时自动镜像 `running-right`。没有 uv 时用 `pip install pillow` 后 `python3 pack.py …`。

6. **自己检查 `preview.png`**：每行帧数对、角色没被裁掉、没有残留背景色、各行大小和形象一致。有问题就重画那一行再打包（加 `--force` 覆盖）。
7. 告诉用户：打开 Familiar 设置「宠物」页就能选到它。中间产物（`frames/`）问用户要不要留。
