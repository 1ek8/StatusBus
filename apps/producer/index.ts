import {xAddBulk} from "redisq/client"
import axios from "axios";
// import {prismaClient} from "store/client"

type intervalObject = NodeJS.Timeout | null

type WebsiteToMonitor = {
  id: string;
  url: string;
  user_id: string;
}

const API_URL = process.env.API_URL || "http://api:3001";
const internalHeaders = { "x-internal-key": process.env.INTERNAL_KEY };

class WebsiteListProducer {
    private isRunning = false
    private intervalId : intervalObject = null 
    private MONITORING_INTERVAL = 1*60*1000

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
            const websites = response.data.websites; // [{id, url, user_id}]

            if (!websites || websites.length === 0) {
                console.log('No websites to monitor')
                return;
            }

            console.log(`Producing monitoring jobs for ${websites.length} websites`)

            await xAddBulk(websites.map((website: WebsiteToMonitor) => ({
                url: website.url,
                id: website.id,
                user_id: website.user_id,
                timestamp: Date.now().toString()
            })))
            .then( ()=> {
                console.log(`${websites.length} jobs queued`)
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