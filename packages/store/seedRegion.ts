import { prisma } from './src/client';

const regionsToCreate = [
    { id: '1', name: 'India' },
    { id: '2', name: 'US' }
];

async function main() {
    console.log(`Start seeding ...`);
    for (const regionData of regionsToCreate) {
        const region = await prisma.region.upsert({
            where: { id: regionData.id },
            update: { name: regionData.name },
            create: regionData,
        });
        console.log(`Region ready: ${region.id} (${region.name})`);
    }
    console.log(`Seeding finished.`);
}

main()
    .catch(async (e) => {
        console.error(e);
        await prisma.$disconnect();
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });