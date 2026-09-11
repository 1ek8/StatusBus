import {z} from "zod";

export const AuthInput = z.object({
    username: z.string(),
    password: z.string()
})

export const WebsiteInput = z.object({
    url: z.string().trim().min(1).max(2048)
})

export const MonitoringTickInput = z.object({
    website_id: z.string().uuid(),
    region_id: z.string(),
    rt_ms: z.number().int().min(0),
    status: z.enum(["Up", "Down"])
})
