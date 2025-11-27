import express from "express";
import jwt from "jsonwebtoken";
import { prisma }  from "store/client";
import { AuthInput } from "./types";
import { authMiddleWare } from "./middleware";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    "https://statusbus.byaniket.online",
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
        let user = await prisma.user.create({
            data: {
                username: user_data.data.username,
                password: user_data.data.password
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
        let user = await prisma.user.findFirst({
            where: {
                username: user_data.data.username,
                password: user_data.data.password
            }
        })
        let token = jwt.sign({
            sub: user?.id
        }, process.env.JWT_SECRET!)
        res.json({
            jwt: token
        })
    } catch (error) {
        res.status(403).send("Couldnt retrieve user data from database");
        return;
    }
})

app.post("/website", authMiddleWare, async (req, res) => {
    if(!req.body.url) {
        return res.status(411).json({});
    }
    const website = await prisma.website.create({
        data: {
            url: req.body.url,
            user_id: req.user_id,
            createdAt: new Date()
        }
    });

    res.json({ id:website.id });
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

app.get("/monitoring/websites", async (req, res) => {
  try {
    const websites = await prisma.website.findMany({
      select: {
        id: true,
        url: true,
        user_id: true,
      },
    });
    res.json({ websites }); // [{ id, url, user_id }]
  } catch (error) {
    res.status(500).json({ error: "Unable to fetch websites to monitor" });
  }
});

app.post("/monitoring/tick", async (req, res) => {
  const { website_id, region_id, rt_ms, status } = req.body;
  if (!website_id || !region_id || typeof rt_ms !== "number" || !status) {
    return res.status(400).json({ error: "Missing fields" });
  }
  try {
    const tick = await prisma.websiteTick.create({
      data: {
        website_id,
        region_id,
        rt_ms,
        status,
      },
    });
    res.json({ tick });
  } catch (error) {
    console.error('Tick creation failed:', error);
    res.status(500).json({ error: "Tick creation failed" });
  }
});

app.get("/health", (req, res) => {
    res.status(200).send('ok')
});

const PORT = Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
});