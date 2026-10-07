import { TRANSFER_POLICY_STATUS, allowedTransferBranchesOf } from '../domain/transfer/transfer.js';
import { TRAVEL_PROVIDER_STATUS, getTravelProviderStatus, makeMissingTravelProvider, makeTravelProvider, makeUnsupportedTravelProvider } from '../domain/travel/travel-provider.js';
export function mapTravelStatus(input, topSolution) {
  const hasMatrix = Boolean(input?.travelTime && typeof input.travelTime === 'object');
  const provider = hasMatrix ? makeTravelProvider(input.travelTime) : makeMissingTravelProvider();
  const status = hasMatrix ? getTravelProviderStatus(provider) : TRAVEL_PROVIDER_STATUS.UNSUPPORTED;
  return {
    h14: status,
    available: status === TRAVEL_PROVIDER_STATUS.READY,
    usedInScoring: Boolean(topSolution?.scoring?.dimensions?.TRAVEL?.active === true),
    detail: status === TRAVEL_PROVIDER_STATUS.READY ? 'A travel matrix is present and travel is a live scoring dimension.' : 'No travel matrix is configured. Travel times between branches are unknown and are not scored (H14 = UNSUPPORTED).'
  };
}
export function mapTransferStatus(input, topSolution) {
  const teachers = input?.teachers ?? [];
  const automatic = input?.transferPolicy === 'AUTO_SHORTAGE';
  const allowedTeacherCount = teachers.filter(t => {
    const allowed = allowedTransferBranchesOf(t);
    return automatic && t.homeBranchId != null || Array.isArray(allowed) && allowed.length > 0;
  }).length;
  const active = teachers.some(teacher => teacher.homeBranchId != null || Array.isArray(teacher.allowedTransferBranches));
  return {
    h13: active ? 'ACTIVE' : TRANSFER_POLICY_STATUS.INACTIVE,
    active,
    policy: automatic ? 'AUTO_SHORTAGE' : 'EXPLICIT',
    allowedTeacherCount,
    usedInScoring: Boolean(topSolution?.scoring?.dimensions?.TRANSFER?.active === true && topSolution?.scoring?.dimensions?.TRANSFER?.weight > 0),
    detail: automatic ? 'Xếp tại phân hiệu chính trước, sau đó tự xét giáo viên cùng chuyên môn còn khả năng nhận tiết để bù thiếu và cân bằng. Phân hiệu mong muốn là ưu tiên mềm; các giới hạn đã khai báo vẫn được kiểm tra.' : active ? `Branch permission is enforced; ${allowedTeacherCount} teacher(s) have explicit allowed transfer branches. Other teachers may work only at their home branch.` : 'No teacher carries an allowedTransferBranches policy, so the transfer constraint is inactive (H13 = INACTIVE) and transfers are not optimized.'
  };
}
export function unsupportedTravelProvider() {
  return makeUnsupportedTravelProvider();
}
