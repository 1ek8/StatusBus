import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { timingSafeEqual } from "crypto";


export const authMiddleWare = (req:Request, res:Response, next: NextFunction) => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
        res.status(401).send("Unauthorized");
        return;
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
        res.status(401).send("Unauthorized");
        return;
    }

    try { 
        let data = jwt.verify(token, process.env.JWT_SECRET!);
        req.user_id = data.sub as string;
        next();
    } catch (e){
        res.status(401).send("Unauthorized");
    }
}

export const internalAuth = (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers["x-internal-key"];
    const expected = process.env.INTERNAL_KEY;

    if (!expected || typeof key !== "string" || key.length !== expected.length) {
        res.status(401).send("Unauthorized");
        return;
    }

    if (!timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
        res.status(401).send("Unauthorized");
        return;
    }

    next();
}




