import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma }  from "store/client";
import { AuthInput, MonitoringTickInput, WebsiteInput } from "./types";
import { authMiddleWare, internalAuth } from "./middleware";
import { assertPublicUrl } from "./lib/validateUrl";
import cors from "cors";

const MAX_WEBSITES_PER_USER = 25;

const websiteRateLimit = (() => {
    const limit = 20;
    const windowMs = 60 * 60 * 1000;
    const hits = new Map<string, number[]>();
    return (userId: string, res: Response): boolean => {
        const now = Date.now();
        const recent = (hits.get(userId) ?? []).filter((t) => now - t < windowMs);
        if (recent.length >= limit) {
            hits.set(userId, recent);
            res.status(429).json({ error: "Too many websites added recently, slow down" });
            return false;
        }
        recent.push(now);
        hits.set(userId, recent);
        return true;
    };
})();

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    "https://statusbus.byaniket.site",
    "http://localhost:3000" // local development
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}))

app.post("/user/signup", async (req, res) => {
    const user_data = AuthInput.safeParse(req.body);
    if (!user_data.success){
        res.status(403).send("");
        return;
    }
    try {
        const hashedPassword = await bcrypt.hash(user_data.data.password, 10);
        let user = await prisma.user.create({
            data: {
                username: user_data.data.username,
                password: hashedPassword
            }
        })
        res.json({
            id: user.id
        })
    } catch (error) {
        res.status(403).send("");
        return;
    }
})

app.post("/user/signin", async (req, res) => {
    const user_data = AuthInput.safeParse(req.body);
    if (!user_data.success){
        res.status(403).send("");
        return;
    }
    try {
        let user = await prisma.user.findUnique({
            where: {
                username: user_data.data.username
            }
        })
        if (!user) {
            res.status(401).json({ error: "Invalid username or password" });
            return;
        }
        const passwordMatches = await bcrypt.compare(user_data.data.password, user.password);
        if (!passwordMatches) {
            if (user.password === user_data.data.password) {
                const hashedPassword = await bcrypt.hash(user.password, 10);
                await prisma.user.update({
                    where: { id: user.id },
                    data: { password: hashedPassword }
                });
            } else {
                res.status(401).json({ error: "Invalid username or password" });
                return;
            }
        }
        let token = jwt.sign({
            sub: user.id
        }, process.env.JWT_SECRET!, {
            expiresIn: "7d"
        });
        res.json({
            jwt: token
        })
    } catch (error) {
        res.status(403).send("Couldnt retrieve user data from database");
        return;
    }
})

app.post("/website", authMiddleWare, async (req, res) => {
    const parsed = WebsiteInput.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid website URL" });
    }
    const url = parsed.data.url;
    try {
        await assertPublicUrl(url);
    } catch (error) {
        return res.status(422).json({ error: error instanceof Error ? error.message : "Invalid URL" });
    }
    if (!websiteRateLimit(req.user_id, res)) {
        return;
    }
    const count = await prisma.website.count({ where: { user_id: req.user_id } });
    if (count >= MAX_WEBSITES_PER_USER) {
        return res.status(429).json({ error: "Website limit reached" });
    }
    const website = await prisma.website.create({
        data: {
            url,
            user_id: req.user_id,
            createdAt: new Date()
        }
    });

    res.json({ id: website.id });
});

app.get("/status/:websiteId", authMiddleWare, async (req, res) => {
    const website = await prisma.website.findFirst({
        where: {
            user_id: req.user_id,
            id: req.params.websiteId
        },
        include: {
            ticks: {
                orderBy: [{
                    createdAt: 'desc'
                }],
                take: 10
            }
        }
    })
    if(!website){
        res.status(409).json({
            message: "Not Found"
        })
        return;
    }
    res.json({
        url: website.url,
        id: website.id,
        user_id:website.user_id
    })
});

app.get("/websites", authMiddleWare, async (req, res) =>{
    const websites = await prisma.website.findMany({
    where: { user_id: req.user_id },
    include: {
        ticks: {
        orderBy: { createdAt: 'desc' },
        take: 1, // Get the latest tick
        },
    },
    });

    // Format the result objects for the frontend
    const formatted = websites.map(site => {
    const latestTick = site.ticks[0];
    return {
        id: site.id,
        url: site.url,
        status: latestTick?.status ?? "Unknown",
        responseTime: latestTick?.rt_ms ?? 0,
        lastChecked: latestTick?.createdAt ?? "NA",
    };
    });
    res.json({ websites: formatted });
});

app.get("/monitoring/websites", internalAuth, async (req, res) => {
  try {
    const websites = await prisma.website.findMany({
      select: {
        id: true,
        url: true,
        user_id: true,
        ticks: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, createdAt: true },
        },
      },
    });
    res.json({
      websites: websites.map((w) => ({
        id: w.id,
        url: w.url,
        user_id: w.user_id,
        lastStatus: w.ticks[0]?.status ?? "Unknown",
        lastCheckedAt: w.ticks[0]?.createdAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "Unable to fetch websites to monitor" });
  }
});

app.post("/monitoring/tick", internalAuth, async (req, res) => {
  const parsed = MonitoringTickInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid tick payload" });
  }
  const { website_id, region_id, rt_ms, status } = parsed.data;
  try {
    const region = await prisma.region.findUnique({ where: { id: region_id } });
    if (!region) {
      return res.status(404).json({ error: "Region does not exist" });
    }
    const tick = await prisma.websiteTick.create({
      data: {
        website_id,
        region_id,
        rt_ms,
        status,
      },
    });
    res.json({ tick });
  } catch (error: any) {
    if (error?.code === "P2003") {
      return res.status(404).json({ error: "Website does not exist" });
    }
    console.error('Tick creation failed:', error);
    res.status(500).json({ error: "Tick creation failed" });
  }
});

app.get("/health", (req, res) => {
    res.status(200).send('ok')
});

const PORT = Number(process.env.PORT);
const HOST = process.env.HOST || '0.0.0.0';

app.get("/", (req, res) => {
    res.status(200).json({ status: "ok" })
});

app.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
});