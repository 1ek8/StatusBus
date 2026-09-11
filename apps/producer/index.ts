import {xAddBulk, capStream} from "redisq/client"
import axios from "axios";
// import {prismaClient} from "store/client"

type intervalObject = NodeJS.Timeout | null

type WebsiteToMonitor = {
  id: string;
  url: string;
  user_id: string;
  lastStatus?: string;
  lastCheckedAt?: string | null;
}

const API_URL = process.env.API_URL || "http://api:3001";
const internalHeaders = { "x-internal-key": process.env.INTERNAL_KEY };

class WebsiteListProducer {
    private isRunning = false
    private intervalId : intervalObject = null 
    private MONITORING_INTERVAL = 1*60*1000
    private BACKOFF_BASE = 5*60*1000
    private BACKOFF_CAP = 20*60*1000
    private consecutiveDown = new Map<string, number>()

    async start(){
        if (this.isRunning){
            console.log("Producer from previous queue is already running")
            return
        }

        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        let connected = false;
        for (let i = 0; i < 10; i++) {
            try {
await axios.get(`${API_URL}/monitoring/websites`, { headers: internalHeaders });
                connected = true;
                console.log("API is reachable, starting monitoring jobs...");
                break;
            } catch (e) {
                console.log(`API not reachable, retrying in 2 seconds (attempt ${i + 1}/10)`);
                await sleep(2000);
            }
        }
        if (!connected) {
            console.error("API is not reachable after retries; producer not starting.");
            return;
        }

        this.isRunning = true

        await this.jobMonitor()
        
        this.intervalId = setInterval(()=> {
            this.jobMonitor()
        }, this.MONITORING_INTERVAL )
    }

    async stop(){
        this.isRunning = false
        console.log("Stopping the monitor . . .")
        if(this.intervalId){
            clearInterval(this.intervalId)
            this.intervalId = null
        }
    }

    private async jobMonitor(){
        try {
            // let websites= await prismaClient.website.findMany({
            //     select:{
            //         url: true,
            //         id: true,
            //         user_id: true
            //     }
            // });

            const response = await axios.get(`${API_URL}/monitoring/websites`, { headers: internalHeaders });
            const websites = response.data.websites; // [{id, url, user_id, lastStatus, lastCheckedAt}]

            if (!websites || websites.length === 0) {
                console.log('No websites to monitor')
                return;
            }

            const toMonitor: WebsiteToMonitor[] = [];
            for (const website of websites) {
                const lastChecked = website.lastCheckedAt ? new Date(website.lastCheckedAt).getTime() : 0;
                if (website.lastStatus === "Down") {
                    const steps = this.consecutiveDown.get(website.id) ?? 0;
                    const wait = Math.min(this.BACKOFF_BASE * Math.pow(2, steps), this.BACKOFF_CAP);
                    const downFor = Math.max(0, Date.now() - lastChecked);
                    if (downFor < wait) {
                        console.log(`Backing off ${website.url} (down for ${Math.round(downFor / 60000)}m, retry after ${Math.round(wait / 60000)}m)`)
                        continue;
                    }
                    this.consecutiveDown.set(website.id, steps + 1);
                } else {
                    this.consecutiveDown.delete(website.id);
                }
                toMonitor.push(website);
            }

            if (toMonitor.length === 0) {
                console.log('All websites are on backoff, nothing to queue')
                return;
            }

            console.log(`Producing monitoring jobs for ${toMonitor.length}/${websites.length} websites`)

            await xAddBulk(toMonitor.map((website: WebsiteToMonitor) => ({
                url: website.url,
                id: website.id,
                user_id: website.user_id,
                timestamp: Date.now().toString()
            })))
            .then( async ()=> {
                await capStream()
                console.log(`${toMonitor.length} jobs queued`)
            })
        } catch (error) {
            console.error('Error producing monitoring jobs:', error)
        }
    }
}

const producer = new WebsiteListProducer()

process.on('SIGINT', async () => {
    console.log('SIGINT signal received')
    await producer.stop()
    process.exit(0)
})

process.on('SIGTERM', async () => {
    console.log('SIGNTERM signal received')
    await producer.stop()
    process.exit(0)
})

producer.start()