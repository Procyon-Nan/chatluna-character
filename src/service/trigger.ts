import { Bot, Context, Service, Session } from 'koishi'
import type { Config } from '../config'
import {
    GroupInfo,
    PendingNextReply,
    PendingWakeUpReply,
    WakeUpReplyRepeatRule,
    WakeUpReplyRecord
} from '../types'
import {
    parseNextReplyReason,
    parseWakeUpTimeToTimestamp
} from '../utils/index'

export class TriggerStore extends Service {
    private _infos: Record<string, GroupInfo> = {}

    private _sessions: Record<string, Session> = {}

    constructor(
        public readonly ctx: Context,
        public _config: Config
    ) {
        super(ctx, 'chatluna_character_trigger')

        this.ctx.database.extend(
            'chathub_character_wake_up_reply',
            {
                id: 'unsigned',
                uid: {
                    type: 'string',
                    length: 16
                },
                sessionKey: {
                    type: 'string',
                    length: 255
                },
                botId: {
                    type: 'string',
                    length: 255
                },
                channelId: {
                    type: 'string',
                    length: 255
                },
                guildId: {
                    type: 'string',
                    length: 255,
                    nullable: true
                },
                userId: {
                    type: 'string',
                    length: 255
                },
                rawTime: {
                    type: 'string',
                    length: 255
                },
                reason: 'text',
                naturalReason: 'text',
                repeatRule: {
                    type: 'string',
                    length: 32,
                    nullable: true
                },
                triggerAtV2: 'timestamp',
                createdAtV2: 'timestamp',
                updatedAt: {
                    type: 'timestamp',
                    nullable: false,
                    initial: new Date()
                }
            },
            {
                autoInc: true,
                primary: 'id'
            }
        )

        ctx.on('ready', async () => {
            // await this.prepareDatabase()

            const rows = await this.ctx.database.get(
                'chathub_character_wake_up_reply',
                {}
            )

            for (const row of rows) {
                const info =
                    this._infos[row.sessionKey] ??
                    (() => {
                        const now = Date.now()
                        const isDirect = row.sessionKey.startsWith('private:')
                        const id = isDirect
                            ? row.sessionKey.slice('private:'.length)
                            : row.sessionKey.startsWith('group:')
                              ? row.sessionKey.slice('group:'.length)
                              : row.sessionKey
                        const guildConfig = isDirect
                            ? this._config.privateConfigs[id]
                            : this._config.configs[id]
                        const globalConfig = isDirect
                            ? this._config.globalPrivateConfig
                            : this._config.globalGroupConfig
                        return createDefaultGroupInfo(
                            Object.assign(
                                {},
                                this._config,
                                globalConfig,
                                guildConfig
                            ),
                            now
                        )
                    })()

                info.pendingWakeUpReplies = info.pendingWakeUpReplies ?? []
                info.pendingWakeUpReplies.push({
                    uid: row.uid,
                    rawTime: row.rawTime,
                    reason: row.reason,
                    naturalReason: row.naturalReason,
                    repeatRule: row.repeatRule ?? 'once',
                    triggerAt: row.triggerAtV2.getTime(),
                    createdAt: row.createdAtV2.getTime()
                })
                this._infos[row.sessionKey] = info

                const bot = ctx.bots[row.botId]
                if (!bot || this._sessions[row.sessionKey]) {
                    continue
                }

                this._sessions[row.sessionKey] = createStoredSession(bot, row)
            }
        })

        ctx.on('bot-status-updated', async (bot) => {
            const rows = await this.ctx.database.get(
                'chathub_character_wake_up_reply',
                {}
            )

            for (const row of rows) {
                if (row.botId !== bot.sid || this._sessions[row.sessionKey]) {
                    continue
                }

                this._sessions[row.sessionKey] = createStoredSession(bot, row)
            }
        })
    }

    get(key: string) {
        return this._infos[key]
    }

    set(key: string, info: GroupInfo) {
        this._infos[key] = info
    }

    async delete(key: string) {
        delete this._infos[key]
        delete this._sessions[key]
        await this.ctx.database.remove('chathub_character_wake_up_reply', {
            sessionKey: key
        })
    }

    keys() {
        return Object.keys(this._infos)
    }

    getLastSession(key: string) {
        return this._sessions[key]
    }

    setLastSession(session: Session) {
        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        this._sessions[key] = session
    }

    registerNextReply(key: string, rawReason: string, config: Config) {
        const groups = parseNextReplyReason(rawReason)
        if (groups.length < 1) {
            return false
        }

        const now = Date.now()
        const info = this._infos[key] ?? createDefaultGroupInfo(config, now)
        const pending: PendingNextReply = {
            rawReason,
            groups,
            sentAt: now
        }

        info.pendingNextReplies = [pending]
        this._infos[key] = info
        return true
    }

    clearNextReplies(key: string) {
        const info = this._infos[key]
        if (!info) return

        info.pendingNextReplies = []
        this._infos[key] = info
    }

    async registerWakeUpReply(
        session: Session,
        rawTime: string,
        reason: string,
        repeatRule: WakeUpReplyRepeatRule,
        config: Config
    ) {
        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const now = Date.now()
        const info = this._infos[key] ?? createDefaultGroupInfo(config, now)
        let uid = Math.random().toString(36).slice(2, 8)
        while ((info.pendingWakeUpReplies ?? []).some((item) => item.uid === uid)) {
            uid = Math.random().toString(36).slice(2, 8)
        }

        const pending = createWakeUpReply(
            uid,
            rawTime,
            reason,
            Date.now(),
            repeatRule
        )
        if (!pending) {
            return false
        }

        info.pendingWakeUpReplies = info.pendingWakeUpReplies ?? []
        info.pendingWakeUpReplies.push(pending)
        this._infos[key] = info
        return pending
    }

    async updateWakeUpReply(
        session: Session,
        uid: string,
        rawTime: string | undefined,
        reason: string | undefined,
        repeatRule: WakeUpReplyRepeatRule | undefined,
        config: Config
    ) {
        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const now = Date.now()
        const info = this._infos[key] ?? createDefaultGroupInfo(config, now)
        const list = [...(info.pendingWakeUpReplies ?? [])]
        const idx = list.findIndex((item) => item.uid === uid)

        if (idx < 0) {
            return false
        }

        const current = list[idx]
        const pending = createWakeUpReply(
            current.uid,
            rawTime?.trim() ? rawTime : current.rawTime,
            reason != null ? reason : current.reason,
            current.createdAt,
            repeatRule ?? current.repeatRule ?? 'once',
            Date.now()
        )
        if (!pending) {
            return false
        }

        list[idx] = pending
        await this.setWakeUpReplies(session, list)
        return true
    }

    async deleteWakeUpReply(session: Session, uid: string) {
        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const list = [...this.getWakeUpReplies(key)]
        const idx = list.findIndex((item) => item.uid === uid)

        if (idx < 0) {
            return false
        }

        list.splice(idx, 1)
        await this.setWakeUpReplies(session, list)
        return true
    }

    rescheduleWakeUpReply(item: PendingWakeUpReply, now: number) {
        if (!item.repeatRule || item.repeatRule === 'once') {
            return undefined
        }

        return createWakeUpReply(
            item.uid,
            item.rawTime,
            item.reason,
            item.createdAt,
            item.repeatRule,
            now + 1000
        )
    }

    async setWakeUpReplies(session: Session, list: PendingWakeUpReply[]) {
        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const now = Date.now()
        const info =
            this._infos[key] ??
            (() => {
                const guildConfig = session.isDirect
                    ? this._config.privateConfigs[session.userId]
                    : this._config.configs[session.guildId]
                const globalConfig = session.isDirect
                    ? this._config.globalPrivateConfig
                    : this._config.globalGroupConfig
                return createDefaultGroupInfo(
                    Object.assign({}, this._config, globalConfig, guildConfig),
                    now
                )
            })()

        info.pendingWakeUpReplies = [...list]
        this._infos[key] = info

        await this.ctx.database.remove('chathub_character_wake_up_reply', {
            sessionKey: key
        })

        if (list.length < 1) {
            return
        }

        await Promise.all(
            list.map(async (item) => {
                await this.ctx.database.create(
                    'chathub_character_wake_up_reply',
                    {
                        uid: item.uid,
                        sessionKey: key,
                        botId: session.bot.sid,
                        channelId: session.channelId ?? session.userId,
                        guildId: session.guildId,
                        userId: session.userId,
                        rawTime: item.rawTime,
                        reason: item.reason,
                        naturalReason: item.naturalReason,
                        repeatRule: item.repeatRule ?? 'once',
                        triggerAtV2: new Date(item.triggerAt),
                        createdAtV2: new Date(item.createdAt),
                        updatedAt: new Date()
                    } satisfies WakeUpReplyRecord
                )
            })
        )
    }

    getWakeUpReplies(key: string) {
        return this._infos[key]?.pendingWakeUpReplies ?? []
    }
}

declare module 'koishi' {
    export interface Context {
        chatluna_character_trigger: TriggerStore
    }
}

function createStoredSession(bot: Bot, temp: WakeUpReplyRecord) {
    const isDirect = temp.sessionKey.startsWith('private:')
    const channelId = temp.channelId ?? temp.userId

    return bot.session({
        channel: {
            id: channelId,
            type: isDirect ? 1 : 0
        },
        guild: isDirect
            ? undefined
            : {
                  id: temp.guildId
              },
        message: {
            id: '0',
            content: ''
        },
        selfId: bot.selfId,
        timestamp: Date.now(),
        type: 'message',
        user: {
            id: temp.userId,
            name: temp.userId
        }
    }) as Session
}

function createWakeUpReply(
    uid: string,
    rawTime: string,
    reason: string,
    now: number,
    repeatRule: WakeUpReplyRepeatRule,
    baseAt = now
): PendingWakeUpReply | undefined {
    const triggerAt = parseWakeUpTime(rawTime, repeatRule, baseAt)
    if (triggerAt == null) {
        return undefined
    }

    const text = reason.trim()
    const time = rawTime.trim()
    const configuredAt = new Date(now)
    const pad = (n: number) => String(n).padStart(2, '0')
    const configuredAtText =
        `${configuredAt.getFullYear()}/${pad(configuredAt.getMonth() + 1)}` +
        `/${pad(configuredAt.getDate())}-${pad(configuredAt.getHours())}` +
        `:${pad(configuredAt.getMinutes())}:${pad(configuredAt.getSeconds())}`

    const repeatText =
        repeatRule === 'once'
            ? ''
            : `, repeat: ${repeatRule}`

    return {
        uid,
        rawTime: time,
        reason: text,
        repeatRule,
        naturalReason: text
            ? `You configured this wake-up at ${configuredAtText} to trigger at ${time}${repeatText}, note: "${text}"`
            : `You configured this wake-up at ${configuredAtText} to trigger at ${time}${repeatText}`,
        triggerAt,
        createdAt: now
    }
}

function parseWakeUpTime(
    rawTime: string,
    repeatRule: WakeUpReplyRepeatRule,
    baseAt: number
) {
    const raw = rawTime.trim()
    if (repeatRule === 'once') {
        return parseWakeUpTimeToTimestamp(raw)
    }

    const time = raw.match(/^(\d{2}):(\d{2}):(\d{2})$/)
    const date = new Date(baseAt)
    const year = date.getFullYear()
    const month = date.getMonth()
    const day = date.getDate()

    if (repeatRule === 'daily' && time) {
        const next = buildDate(year, month, day, time[1], time[2], time[3])
        if (!next) return null
        if (next.getTime() > baseAt) return next.getTime()
        next.setDate(next.getDate() + 1)
        return next.getTime()
    }

    const weekly = raw.match(/^([1-7])-(\d{2}):(\d{2}):(\d{2})$/)
    if (repeatRule === 'weekly' && weekly) {
        const weekday = Number.parseInt(weekly[1], 10) % 7
        const next = buildDate(year, month, day, weekly[2], weekly[3], weekly[4])
        if (!next) return null
        next.setDate(next.getDate() + (weekday - next.getDay() + 7) % 7)
        if (next.getTime() <= baseAt) next.setDate(next.getDate() + 7)
        return next.getTime()
    }

    const monthly = raw.match(/^(\d{2})-(\d{2}):(\d{2}):(\d{2})$/)
    if (repeatRule === 'monthly' && monthly) {
        const targetDay = Number.parseInt(monthly[1], 10)
        for (let i = 0; i < 24; i++) {
            const next = buildDate(
                year,
                month + i,
                targetDay,
                monthly[2],
                monthly[3],
                monthly[4]
            )
            if (next && next.getTime() > baseAt) return next.getTime()
        }
        return null
    }

    const yearly = raw.match(/^(\d{2})\/(\d{2})-(\d{2}):(\d{2}):(\d{2})$/)
    if (repeatRule === 'yearly' && yearly) {
        const targetMonth = Number.parseInt(yearly[1], 10) - 1
        const targetDay = Number.parseInt(yearly[2], 10)
        for (let i = 0; i < 8; i++) {
            const next = buildDate(
                year + i,
                targetMonth,
                targetDay,
                yearly[3],
                yearly[4],
                yearly[5]
            )
            if (next && next.getTime() > baseAt) return next.getTime()
        }
    }

    return null
}

function buildDate(
    year: number,
    month: number,
    day: number,
    rawHour: string,
    rawMinute: string,
    rawSecond: string
) {
    const hour = Number.parseInt(rawHour, 10)
    const minute = Number.parseInt(rawMinute, 10)
    const second = Number.parseInt(rawSecond, 10)
    const expected = new Date(year, month, 1, 0, 0, 0, 0)
    const date = new Date(year, month, day, hour, minute, second, 0)

    if (
        date.getFullYear() !== expected.getFullYear() ||
        date.getMonth() !== expected.getMonth() ||
        date.getDate() !== day ||
        date.getHours() !== hour ||
        date.getMinutes() !== minute ||
        date.getSeconds() !== second
    ) {
        return undefined
    }

    return date
}

export function createDefaultGroupInfo(
    config: Config,
    now: number
): GroupInfo {
    return {
        messageCount: 0,
        messageWait: false,
        messageTimestamps: [],
        messageTimestampsByUserId: {},
        lastActivityScore: 0,
        lastScoreUpdate: 0,
        lastResponseTime: 0,
        currentActivityThreshold: config.messageActivityScoreLowerLimit,
        lastUserMessageTime: now,
        passiveRetryCount: 0,
        currentIdleWaitSeconds: undefined,
        pendingNextReplies: [],
        pendingWakeUpReplies: []
    }
}
