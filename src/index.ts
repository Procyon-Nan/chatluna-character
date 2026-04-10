/* eslint-disable max-len */
import { Context } from 'koishi'
import { plugins } from './plugin'
import { type Config, migrateConfig } from './config'
import { MessageCollector } from './service/message'
import { TriggerStore } from './service/trigger'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { } from '@koishijs/plugin-console'

export function apply(ctx: Context, config: Config) {
    const changed = migrateConfig(config)
    let started = false

    ctx.plugin(TriggerStore, config)
    ctx.plugin(MessageCollector, config)
    ctx.plugin(
        {
            apply: (ctx: Context, config: Config) => {
                ctx.on('ready', async () => {
                    if (started) {
                        return
                    }
                    started = true
                    if (changed) {
                        Object.assign(ctx.scope.config, config)
                        await ctx.loader.writeConfig()
                    }
                    await ctx.chatluna_character.preset.init()
                    await plugins(ctx, config)
                })
            },
            inject: Object.assign({}, inject2, {
                chatluna_character: {
                    required: true
                },
                chatluna_character_trigger: {
                    required: true
                }
            }),
            name: 'chatluna_character_entry_point'
        },
        config
    )

    ctx.inject(['console'], (ctx) => {
        const baseDir =
            typeof __dirname !== 'undefined'
                ? __dirname
                : dirname(fileURLToPath(import.meta.url))

        ctx.console.addEntry({
            dev: resolve(baseDir, '../dist'),
            prod: resolve(baseDir, '../dist')
        })
    })

    ctx.middleware((session, next) => {
        if (!ctx.chatluna_character) {
            return next()
        }

        // 不接收自己的消息
        if (ctx.bots[session.uid]) {
            return next()
        }

        const id = session.isDirect ? session.userId : session.guildId

        if (
            session.isDirect &&
            config.privateWhitelistMode &&
            !config.applyPrivate.includes(id)
        ) {
            return next()
        }

        if (
            !session.isDirect &&
            config.groupWhitelistMode &&
            !config.applyGroup.includes(id)
        ) {
            return next()
        }

        return next(async (loop) => {
            if (!(await ctx.chatluna_character.broadcast(session))) {
                return loop()
            }
        })
    })
}

export const inject = {
    required: ['chatluna', 'database'],
    optional: [
        'chatluna_character',
        'chatluna_character_trigger',
        'vits',
        'console'
    ]
}

export const inject2 = {
    chatluna: {
        required: true
    },
    chatluna_character: {
        required: false
    },
    chatluna_character_trigger: {
        required: false
    },
    vits: {
        required: false
    },
    console: {
        required: false
    },
    database: {
        required: true
    }
}

export const usage = `
## chatluna-character

请先阅读[**此文档**](https://chatluna.chat/ecosystem/other/character.html)了解使用方式。

### 26.04.11

“工具调用回复”功能的配置项已从“基础配置”下放至全局私聊／全局群聊／分私聊／分群聊配置中，并且支持分别调整 \`status\`、\`think\`、\`next_reply\`、\`wake_up_reply\` 字段是否启用。

使用“工具调用回复”功能时，请尽可能使用模型官方（推荐的）API 格式（如：Gemini 使用 Gemini 适配器，Claude 及其他支持 Anthropic API 的模型使用 Claude 适配器），否则可能遇到无法正常完成回复的问题（尤其是 Minimax 等模型）。

### 26.04.05

伪装插件新增实验性“工具调用回复”功能，详情请查看文档。

本次更新也对部分旧的 XML 格式进行了调整（如发送图片/表情包、设置触发器等），请参考最新文档对预设进行修改，避免消息发送异常。
`

export { Config } from './config'
export const name = 'chatluna-character'
