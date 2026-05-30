import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import applicationsRouter from "./applications";
import taskCreateRouter from "./task-create";
import discordOAuthRouter from "./discord-oauth";
import googleOAuthRouter from "./google-oauth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin", adminRouter);
router.use("/admin", applicationsRouter);
router.use("/admin", taskCreateRouter);
router.use("/admin", discordOAuthRouter);
router.use("/admin", googleOAuthRouter);

export default router;
