import { request, RequestOptions } from '@codeblitzjs/ide-common';
import { Autowired, Injectable } from '@opensumi/di';
import { isObject, MessageType, URI } from '@opensumi/ide-core-common';
import { CodePlatformRegistry, HelperService } from '../common';
import {
  Branch,
  BranchOrTag,
  CodePlatform,
  CommitFileChange,
  CommitParams,
  CommitRecord,
  EntryInfo,
  EntryParam,
  FileAction,
  FileActionHeader,
  FileActionResult,
  GetEntryInfoParam,
  GitlensBlame,
  ICodeAPIService,
  IRepositoryModel,
  ISearchResults,
  Project,
  TreeEntry,
} from '../common/types';
import { CodeAPI as ConflictAPI } from '../common/types';
import { API } from './types';

@Injectable()
export class AtomGitAPIService implements ICodeAPIService {
  @Autowired(HelperService)
  helper: HelperService;

  private config = CodePlatformRegistry.instance().getPlatformConfig(CodePlatform.atomgit);

  private _PRIVATE_TOKEN: string | null;

  get PRIVATE_TOKEN() {
    if (!this._PRIVATE_TOKEN) {
      this._PRIVATE_TOKEN = this.helper.ATOMGIT_TOKEN;
      return this._PRIVATE_TOKEN;
    }

    return this._PRIVATE_TOKEN;
  }

  constructor() {
    this._PRIVATE_TOKEN = this.config.token || this.helper.ATOMGIT_TOKEN || '';
  }
  getEntryInfo(repo: IRepositoryModel, entry: GetEntryInfoParam): Promise<EntryInfo> {
    throw new Error('Method not implemented.');
  }
  getBranchNames?(repo: IRepositoryModel): Promise<string[]> {
    throw new Error('Method not implemented.');
  }
  createPullRequest(
    repo: IRepositoryModel,
    sourceBranch: string,
    targetBranch: string,
    title: string,
    autoMerge?: boolean | undefined,
  ): Promise<ConflictAPI.ResponseCreatePR> {
    throw new Error('Method not implemented.');
  }

  private sleep(t: number) {
    return new Promise(res => {
      setTimeout(() => {
        res(undefined);
      }, t);
    });
  }

  private async checkAccessToken(): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      resolve(true);
      // 一开始就弹出弹窗会有颜色闪烁问题，先临时 sleep 处理，后面再优化
      await this.sleep(300);

      const btn = await this.helper.showDialog({
        message: '检测到 OAuth 未授权',
        type: MessageType.Info,
        closable: false,
        buttons: ['去授权'],
      });

      let popupWindow;
      if (btn === '去授权') {
        popupWindow = window.open(
          `${this.config.origin}/login/oauth/authorize?client_id=9d8b531661f441d1`,
          '_blank',
          'directories=no,titlebar=no,toolbar=no,location=no,status=no,menubar=no,scrollbars=no,resizable=no,width=800,height=520,top=150,left=150',
        );
      }

      const handleMessage = async (event: MessageEvent) => {
        try {
          const { data } = event;
          if (isObject(data) && data.type === 'atomgit') {
            const { data: { token } } = data;
            popupWindow?.close();
            if (!token) {
              resolve(false);
              return;
            }

            // 清理过期的 token；
            this.clearToken();

            this.helper.ATOMGIT_TOKEN = token;
            this.helper.reinitializeCodeService(true);

            resolve(true);
          }
        } catch (error) {
          reject(error);
        }
      };
      window.addEventListener('message', handleMessage);
    });
  }

  public async available(): Promise<boolean> {
    const token = this.PRIVATE_TOKEN;
    if (!token) {
      return await this.checkAccessToken();
    }
    return true;
  }

  private showErrorMessage(symbol: string, message?: string, status?: number) {
    this.helper.showMessage(CodePlatform.atomgit, {
      type: MessageType.Error,
      status,
      symbol,
      message,
    });
  }

  protected async request<T>(path: string, options?: RequestOptions, responseOptions?: API.RequestResponseOptions): Promise<T> {
    try {
      const { headers, ...rest } = options || {};
      const privateToken = this.PRIVATE_TOKEN;
      return await request(path, {
        baseURL: options?.baseURL ?? this.config.endpoint,
        responseType: 'json',
        headers: {
          ...(privateToken
            ? {
              'Authorization': `Bearer ${privateToken}`,
            }
            : {}),
          ...headers,
        },
        ...rest,
      });
    } catch (err: any) {
      const status = err.response?.status;
      let messageKey = 'error.request';
      if (status === 401) {
        messageKey = 'atomgit.unauthorized';
        // 401 的情况再登陆一次
        await this.checkAccessToken();
      } else if (status === 404) {
        messageKey = 'error.resource-not-found';
      }
      if (responseOptions?.errorOption === false) {
        console.log(err);
        return undefined as any;
      }
      this.showErrorMessage(messageKey, status);
      throw err;
    }
  }

  private getProjectPath(repo: IRepositoryModel) {
    return `${repo.owner}/${repo.name}`;
  }

  async getCommit(repo: IRepositoryModel, ref: string): Promise<string> {
    const commitInfo = await this.request<API.ResponseCommit>(
      `/repos/${this.getProjectPath(repo)}/branches/${encodeURIComponent(ref)}`,
    );
    return commitInfo.commit.sha;
  }
  async getTree(repo: IRepositoryModel, path: string): Promise<TreeEntry[]> {
    const { owner, name, commit } = repo;
    const res = await this.request<API.ResponseFileTree[]>(`/repos/${owner}/${name}/trees/${commit}`, {
      params: {
        file_path: path,
      },
    });

    return Array.isArray(res)
      ? res.map(data => {
        const name = URI.parse(data.path).displayName;

        return {
          ...data,
          name,
        } as TreeEntry;
      })
      : [];
  }
  async getBlob(repo: IRepositoryModel, entry: EntryParam): Promise<Uint8Array> {
    const { path } = entry;
    const { ref } = repo;
    const res = await this.request<API.ResponseContentBlob>(
      `/repos/${this.getProjectPath(repo)}/contents`,
      {
        params: {
          ref,
          path,
        },
      },
    );

    const { content, encoding, type } = res;

    if (type !== 'file') {
      throw new Error(`${path} is not a file.`);
    }

    if (encoding === 'base64') {
      return Buffer.from(decodeURIComponent(escape(atob(content))));
    }

    return Buffer.from(content);
  }
  async getBlobByCommitPath(repo: IRepositoryModel, commit: string, path: string, options?: API.RequestResponseOptions): Promise<Uint8Array> {
    const res = await this.request<API.ResponseInfoAndBlobs>(
      `/repos/${this.getProjectPath(repo)}/contents/file`,
      {
        params: {
          path: path,
          ref: commit
        },
      },
      options
    );

    const { content, encoding, type } = res;

    if (type !== 'file') {
      throw new Error(`${path} is not a file.`);
    }

    if (encoding === 'base64') {
      return Buffer.from(decodeURIComponent(escape(atob(content))));
    }

    return Buffer.from(content);
  }
  async getBranches(repo: IRepositoryModel): Promise<BranchOrTag[]> {
    if (!this.PRIVATE_TOKEN) {
      return [];
    }

    const branches = await this.request<API.ResponseBranchesInfo[]>(`/repos/${this.getProjectPath(repo)}/branches`);
    if (!Array.isArray(branches)) {
      throw new Error('[can not find branch list]');
    }

    return branches.map((data) => ({
      name: data.name,
      commit: {
        id: data.commit.sha,
      },
      protected: data.protected,
    }));
  }
  async getTags(_repo: IRepositoryModel): Promise<BranchOrTag[]> {
    return [];
  }
  transformStaticResource(_repo: IRepositoryModel, _path: string): string {
    throw new Error('Method not implemented.');
  }
  async searchContent(
    _repo: IRepositoryModel,
    _searchString: string,
    _options: { limit: number },
  ): Promise<ISearchResults> {
    return [];
  }
  async searchFile(
    _repo: IRepositoryModel,
    _searchString: string,
    _options: { limit?: number | undefined },
  ): Promise<string[]> {
    return [];
  }
  async getFileBlame(repo: IRepositoryModel, filepath: string): Promise<Uint8Array> {
    const res = await this.request<API.ResponseFileBlame[]>(`/repos/${this.getProjectPath(repo)}/files/blame`, {
      params: {
        file_path: filepath,
        sha: repo.commit,
      },
    });

    const blameHash = {};
    const blamePart: GitlensBlame[] = [];

    res.forEach((blame, _index) => {
      const commit = blame.commit;
      if (blameHash[commit.id]) {
        const bla = blamePart.find((b) => b.commit.id === blame.commit.id);
        if (!bla) {
          return;
        }

        bla.lines.push({
          current_number: blame.start,
          effect_line: blame.contents.length,
          previous_number: blame.start,
        });
      } else {
        blameHash[commit.id] = true;
        blamePart.push({
          commit: {
            id: commit.id,
            author_name: commit.author_name,
            author_email: commit.author_email || 'no_email',
            authored_date: new Date(commit.created_at).getTime(),
            committed_date: new Date(commit.created_at).getTime(),
            message: commit.title,
            author: {
              avatar_url: commit?.user?.avatar_url || '',
            },
          },
          lines: [
            {
              current_number: blame.start,
              effect_line: blame.contents.length,
              previous_number: blame.start,
            },
          ],
        });
      }
    });

    return new TextEncoder().encode(JSON.stringify(blamePart));
  }
  getCommits(_repo: IRepositoryModel, _params: CommitParams): Promise<CommitRecord[]> {
    throw new Error('Method not implemented.');
  }
  getCommitDiff(_repo: IRepositoryModel, _sha: string): Promise<CommitFileChange[]> {
    throw new Error('Method not implemented.');
  }
  getCommitCompare(_repo: IRepositoryModel, _from: string, _to: string): Promise<CommitFileChange[]> {
    throw new Error('Method not implemented.');
  }
  async getFiles(repo: IRepositoryModel): Promise<string[]> {
    const fileList = await this.request<API.ResponseFileNames[]>(
      `/repos/${this.getProjectPath(repo)}/trees/${repo.commit}`,
      {
        params: {
          recursive: 'true',
        },
      },
    );
    return (fileList || []).filter(f => f.type === 'blob').map((f) => f.path);
  }
  async bulkChangeFiles(repo: IRepositoryModel, actions: FileAction[], header: FileActionHeader): Promise<FileActionResult[]> {
    const res = await this.request<API.ResponseCommitInfo>(
      `/repos/${this.getProjectPath(repo)}/commits/create`,
      {
        data: {
          actions: actions.map((action) => ({
            action: action.action_type.toLocaleLowerCase(),
            file_path: action.file_path,
            content: action.content,
            previous_path: action.file_path,
          })),
          branch: header.branch,
          commit_message: header.commit_message,
        },
        method: 'post',
      },
    );
    const resCommit = {
      branch_created: false,
      branch: header.branch,
      commit_id: res.id,
      file_name: '',
      ...res,
    };
    // 没有提交ID 说明提交失败
    if (res.id) {
      return [resCommit] as FileActionResult[];
    }
    return [];
  }
  async createBranch(repo: IRepositoryModel, newBranch: string, ref: string): Promise<Branch> {
    const res = await this.request<API.ResponseBranch>(`/repos/${this.getProjectPath(repo)}/git/refs`, {
      method: 'post',
      data: {
        sha: ref,
        ref: newBranch,
      },
    });

    const resBranch: Branch = {
      commit: {
        id: res.object?.sha,
      },
      name: res.ref,
      ref: res.ref,
    }

    return resBranch;
  }
  getUser(_repo: IRepositoryModel): Promise<any> {
    return {} as any;
  }

  public async getProject(repo: IRepositoryModel): Promise<Project> {
    const repoInfo = await this.request<API.ResponseRepoInfo>(`/repos/${this.getProjectPath(repo)}`);
    return {
      id: repoInfo.name,
      default_branch: repoInfo.default_branch,
    };
  }
  canResolveConflict(
    _repo: IRepositoryModel,
    _sourceBranch: string,
    _targetBranch: string,
    _prId: string,
  ): Promise<ConflictAPI.CanResolveConflictResponse> {
    throw new Error('Method not implemented.');
  }
  resolveConflict(
    _repo: IRepositoryModel,
    _content: ConflictAPI.ResolveConflict,
    _sourceBranch: string,
    _targetBranch: string,
    _prId?: string | undefined,
  ): Promise<ConflictAPI.ResolveConflictResponse> {
    throw new Error('Method not implemented.');
  }
  getConflict(
    _repo: IRepositoryModel,
    _sourceBranch: string,
    _targetBranch: string,
  ): Promise<ConflictAPI.ConflictResponse> {
    throw new Error('Method not implemented.');
  }
  mergeBase(_repo: IRepositoryModel, _target: string, _source: string): Promise<ConflictAPI.ResponseCommit> {
    throw new Error('Method not implemented.');
  }

  clearToken() {
    this._PRIVATE_TOKEN = null;
    this.helper.ATOMGIT_TOKEN = null;
  }
}
