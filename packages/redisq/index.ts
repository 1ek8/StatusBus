import { createClient } from "redis"
import type { StreamEntry, MessageType, RawRedisMessage } from "shared-types"

const client = await createClient({ url: process.env.REDIS_URL })
    .on("error", (err) => {
        console.log("Redis Client Error", err)
    })
    .connect();

type websiteArgs = { url: string, id: string }
const STREAM_NAME = 'statusbus:web'
const STREAM_MAX_LEN = 100_000

export async function xAdd({ url, id }: websiteArgs) {
    await client.xAdd(
        STREAM_NAME, '*', {
        url,
        id
    })
}

export async function xAddBulk(websites: websiteArgs[]) {
    for (const website of websites) {
        await xAdd({
            url: website.url,
            id: website.id
        })
    }
}

export async function capStream() {
    await client.xTrim(STREAM_NAME, 'MAXLEN', STREAM_MAX_LEN, { strategyModifier: '~' })
}

export async function xAutoClaim(
    consumerGroup: string,
    consumerId: string,
    minIdleTimeMs: number = 5 * 60 * 1000,
    count: number = 10
): Promise<StreamEntry<MessageType>[]> {
    const response = await client.xAutoClaim(STREAM_NAME, consumerGroup, consumerId, minIdleTimeMs, '0', {
        COUNT: count
    });

    const claimed: StreamEntry<MessageType>[] = [];
    for (const raw of response.messages ?? []) {
        const url = raw.message?.url;
        const id = raw.message?.id;
        if (typeof url === 'string' && typeof id === 'string') {
            claimed.push({ id: raw.id, message: { url, id } });
        }
    }
    return claimed;
}

// Add this new function
export async function xGroupCreate(
    consumerGroup: string,
    startId: string = "0"
): Promise<void> {
    try {
        await client.xGroupCreate(STREAM_NAME, consumerGroup, startId, {
            MKSTREAM: true
        });
        console.log(`Consumer group '${consumerGroup}' created successfully`);
    } catch (error: any) {
        if (error.message.includes('BUSYGROUP')) {
            console.log(`Consumer group '${consumerGroup}' already exists`);
        } else {
            throw error;
        }
    }
}

export async function xReadGroup(
    consumerGroup: string, consumerId: string
): Promise<StreamEntry<MessageType>[]> {
    const response = await client.xReadGroup(consumerGroup, consumerId, {
        key: STREAM_NAME,
        id: '>'
    }, {
        'COUNT': 5
    });


    // 1. Guard against null or non-array responses.
    //    This check ensures 'response' is an array and not empty.
    if (!response || !Array.isArray(response) || response.length === 0) {
        return [];
    }

    // After this check, TypeScript knows 'response' is an array.
    // The error on the next line is now resolved.
    const firstStream = response[0];

    // 2. Guard the structure of the stream object itself.
    if (
        !firstStream ||
        typeof firstStream !== 'object' ||
        !('messages' in firstStream) ||
        !Array.isArray(firstStream.messages)
    ) {
        return [];
    }

    const rawMessages = firstStream.messages as RawRedisMessage[];
    const typedMessages: StreamEntry<MessageType>[] = [];
    for (const msg of rawMessages) {
        const url = msg.message?.url;
        const id = msg.message?.id;
        if (typeof url === 'string' && typeof id === 'string') {
            typedMessages.push({
                id: msg.id,
                message: { url, id }
            });
        }
    }
    return typedMessages;
}

export async function xAck(consumerGroup: string, eventId: string) {
    const response = await client.xAck(STREAM_NAME, consumerGroup, eventId)
    console.log(response)
}

export async function xAckBulk(consumerGroup: string, eventIdArray: string[]) {
    eventIdArray.map(async (eventId) => {
        await xAck(consumerGroup, eventId)
    })
}