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

### 26.05.13

\`wake_up_reply\` 已拆分为独立工具，并支持一次性、每天、每周、每月、每年重复触发；开关位于各私聊／群聊配置“空闲触发”下方的“计划任务”分组，需同时开启“工具调用”。旧 XML 解析仅保留为历史兼容，默认预设和运行时提示不再引导使用 XML。

### 26.05.19

新增 \`<audio>\` 音频文件消息，支持 XML 与工具调用输出；\`<voice>\` 仍仅用于 TTS。详见文档。
`

export { Config } from './config'
export type {
    CharacterAfterChatEventPayload,
    CharacterBeforeChatEventPayload,
    CharacterClearChatHistoryEventPayload
} from './types'
export const name = 'chatluna-character'
