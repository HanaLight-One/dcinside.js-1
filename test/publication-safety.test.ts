import {expect, test} from "bun:test";
import {publicationDiagnostic, ApiError} from "../src";
import {json, loggedIn, makeClient} from "./helpers";

const options = () => ({gallery: "chatgpt", subject: "fixture", content: ["body"]});
for (const cause of ["certification", "certification_login"]) {
    test(`write never refreshes or replays ${cause}`, async () => {
        const {dc, requests} = makeClient(() => json({result: false, cause}), loggedIn);
        await expect(dc.articles.write(options())).rejects.toThrow();
        expect(requests).toHaveLength(1);
    });
}
for (const body of ["<html>security check</html>", "{}", '{"result":"maybe"}', "null"]) {
    test(`unconfirmed write response fails: ${body}`, async () => {
        const {dc, requests} = makeClient(() => new Response(body), loggedIn);
        await expect(dc.articles.write(options())).rejects.toThrow();
        expect(requests).toHaveLength(1);
    });
}
test("failed durable intent prevents submission", async () => {
    const {dc, requests} = makeClient(() => json({result:true}), loggedIn);
    await expect(dc.articles.write({...options(), beforeSubmit: async () => {throw new Error("disk full");}})).rejects.toThrow("disk full");
    expect(requests).toHaveLength(0);
});
test("empty image fails before submission", async () => {
    const {dc, requests} = makeClient(() => json({result:true}), loggedIn);
    await expect(dc.articles.write({...options(), content:[{type:"image",file:new Blob()}]})).rejects.toThrow();
    expect(requests).toHaveLength(0);
});
test("diagnostic does not leak arbitrary error payload", () => {
    const d = publicationDiagnostic(new ApiError("private-password", {token:"private-token"}));
    expect(JSON.stringify(d)).not.toContain("private");
    expect(d.retryable).toBe(false);
    expect(publicationDiagnostic(new ApiError("잠시후 다시 이용해주세요.", {}))).toMatchObject({reason:"try-later-unspecified"});
});
test("refresh_join cannot replay a write", async () => {
    const {dc, requests} = makeClient(() => json({refresh_join:true}), loggedIn);
    await expect(dc.articles.write(options())).rejects.toThrow();
    expect(requests).toHaveLength(1);
});
test("24 image blocks remain ordered and writes disable redirect replay", async () => {
    const {dc, requests} = makeClient(() => json({result:true}), loggedIn);
    let called=0;
    await dc.articles.write({...options(), beforeSubmit:async()=>{called++;},
        content:Array.from({length:24},(_,i)=>({type:"image" as const,file:new File([`image-${i}`],`${i}.png`,{type:"image/png"})}))});
    expect(called).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.raw.redirect).toBe("error");
    for(let i=0;i<24;i++) {
        expect(requests[0]!.fields[`memo_block[${i}]`]).toBe(`Dc_App_Img_${i}`);
        expect(await requests[0]!.files[`upload[${i}]`]!.text()).toBe(`image-${i}`);
    }
});
