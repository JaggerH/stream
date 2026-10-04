/** npm 自己的包名文法（scope 可选、小写、有限标点）——**前后端唯一真相源**。
 *
 *  后端拿它守安装门：`name` 从 HTTP 上来，`dirNameFor` 用它派生目录名，install 会
 *  递归删除那个目录——一个 `'@x/y/../../evil'` 若被无检查地信任，就是一把目录穿越 /
 *  任意删除的原语。前端拿它判「这串输入是不是包名」来决定给不给按名直装项。
 *
 *  两份正则一旦漂移，就会出现「前端给了安装项、后端 400 拒绝」或「前端不给、其实
 *  能装」——而这类错位不会有任何测试报警，所以判据只允许存在这一份。 */
export const NPM_NAME_RE = /^(@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/

export function isValidPackageName(name: string): boolean {
  return NPM_NAME_RE.test(name)
}
