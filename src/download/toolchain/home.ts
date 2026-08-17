import {userInfo} from 'node:os';

type UserInfoProvider = () => Pick<ReturnType<typeof userInfo>, 'homedir'>;

export const currentUidHomeDirectory = (
  provideUserInfo: UserInfoProvider = userInfo,
): string => provideUserInfo().homedir;
