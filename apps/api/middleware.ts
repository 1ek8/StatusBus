import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";


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




