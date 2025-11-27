import { prisma } from 'store/client';

const regionsToCreate = [
    { id: '1', name: 'India' },
    { id: '2', name: 'US' }
];

async function main() {
    console.log(`Start seeding ...`);
    for (const regionData of regionsToCreate) {
        const region = await prisma.region.create({
            data: regionData,
        });
        console.log(`Created region with id: ${region.id}`);
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
